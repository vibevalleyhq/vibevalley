#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

static dispatch_queue_t audioQueue;
static AVAudioPlayer *filePlayer;
static AVAudioEngine *pcmEngine;
static AVAudioPlayerNode *pcmPlayer;
static AVAudioFormat *pcmFormat;
static NSUInteger queuedFrames;
static NSUInteger generation;

static dispatch_queue_t queue(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{ audioQueue = dispatch_queue_create("dev.vibevalley.audio", DISPATCH_QUEUE_SERIAL); });
    return audioQueue;
}

static void failure(char *buffer, size_t capacity, NSString *message) {
    if (capacity) snprintf(buffer, capacity, "%s", message.UTF8String ?: "audio operation failed");
}

static void stop(void) {
    generation++;
    [filePlayer stop];
    filePlayer = nil;
    [pcmPlayer stop];
    [pcmEngine stop];
    pcmPlayer = nil;
    pcmEngine = nil;
    pcmFormat = nil;
    queuedFrames = 0;
}

bool vv_audio_play(const char *path, double position, char *error, size_t capacity) {
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        NSError *problem = nil;
        AVAudioPlayer *next = [[AVAudioPlayer alloc] initWithContentsOfURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] error:&problem];
        if (!next) { failure(error, capacity, problem.localizedDescription); return; }
        if (position > next.duration) { failure(error, capacity, @"audio position exceeds duration"); return; }
        next.currentTime = position;
        if (![next prepareToPlay]) { failure(error, capacity, @"audio output is unavailable"); return; }
        stop();
        if (![next play]) { failure(error, capacity, @"audio playback could not start"); return; }
        filePlayer = next;
        ok = true;
    }});
    return ok;
}

bool vv_audio_seek(double position, char *error, size_t capacity) {
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        if (!filePlayer) { failure(error, capacity, @"no audio file is loaded"); return; }
        if (position > filePlayer.duration) { failure(error, capacity, @"audio position exceeds duration"); return; }
        filePlayer.currentTime = position;
        ok = true;
    }});
    return ok;
}

void vv_audio_state(double *position, double *duration, bool *playing) {
    dispatch_sync(queue(), ^{
        *position = filePlayer.currentTime;
        *duration = filePlayer.duration;
        *playing = filePlayer.isPlaying || (pcmPlayer.isPlaying && queuedFrames > 0);
    });
}

void vv_audio_stop(void) { dispatch_sync(queue(), ^{ @autoreleasepool { stop(); } }); }

bool vv_pcm_start(double rate, unsigned int channels, char *error, size_t capacity) {
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        stop();
        AVAudioEngine *engine = [[AVAudioEngine alloc] init];
        AVAudioPlayerNode *player = [[AVAudioPlayerNode alloc] init];
        AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:rate channels:channels];
        if (!format) { failure(error, capacity, @"invalid PCM format"); return; }
        [engine attachNode:player];
        [engine connect:player to:engine.mainMixerNode format:format];
        NSError *problem = nil;
        if (![engine startAndReturnError:&problem]) { failure(error, capacity, problem.localizedDescription); return; }
        [player play];
        pcmEngine = engine;
        pcmPlayer = player;
        pcmFormat = format;
        ok = true;
    }});
    return ok;
}

bool vv_pcm_append(const unsigned char *bytes, size_t length, char *error, size_t capacity) {
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        if (!pcmPlayer) { failure(error, capacity, @"PCM playback has not started"); return; }
        unsigned int channels = pcmFormat.channelCount;
        if (length % (channels * 2) != 0) { failure(error, capacity, @"PCM chunk contains a partial sample frame"); return; }
        NSUInteger frames = length / (channels * 2);
        if (frames == 0) { ok = true; return; }
        // Bound pending playback to five seconds; the caller must apply backpressure.
        if (frames + queuedFrames > pcmFormat.sampleRate * 5) { failure(error, capacity, @"PCM playback queue is full"); return; }
        AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:pcmFormat frameCapacity:(AVAudioFrameCount)frames];
        buffer.frameLength = (AVAudioFrameCount)frames;
        for (NSUInteger frame = 0; frame < frames; frame++) {
            for (unsigned int channel = 0; channel < channels; channel++) {
                NSUInteger i = (frame * channels + channel) * 2;
                int16_t sample = (int16_t)((uint16_t)bytes[i] | ((uint16_t)bytes[i + 1] << 8));
                buffer.floatChannelData[channel][frame] = (float)sample / 32768.0f;
            }
        }
        queuedFrames += frames;
        NSUInteger current = generation;
        [pcmPlayer scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) {
            dispatch_async(queue(), ^{ if (current == generation) queuedFrames -= frames; });
        }];
        ok = true;
    }});
    return ok;
}
