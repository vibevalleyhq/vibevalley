#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

static dispatch_queue_t audioQueue;
static AVAudioPlayer *filePlayer;
static AVAudioEngine *pcmEngine;
static AVAudioPlayerNode *pcmPlayer;
static AVAudioFormat *pcmFormat;
static NSUInteger queuedFrames;
static NSUInteger completedFrames;
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
    completedFrames = 0;
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

bool vv_audio_play_data(const unsigned char *bytes, size_t length, char *error, size_t capacity) {
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        NSData *data = [NSData dataWithBytes:bytes length:length];
        NSError *problem = nil;
        AVAudioPlayer *next = [[AVAudioPlayer alloc] initWithData:data error:&problem];
        if (!next) { failure(error, capacity, problem.localizedDescription); return; }
        if (![next prepareToPlay]) { failure(error, capacity, @"audio output is unavailable"); return; }
        stop();
        if (![next play]) { failure(error, capacity, @"audio playback could not start"); return; }
        filePlayer = next;
        ok = true;
    }});
    return ok;
}

void vv_audio_state(bool *playing, double *queued) {
    dispatch_sync(queue(), ^{
        *playing = filePlayer.isPlaying || (pcmPlayer.isPlaying && queuedFrames > 0);
        *queued = pcmEngine && !pcmEngine.isRunning && queuedFrames > 0 ? -1 : (pcmFormat ? (double)queuedFrames / pcmFormat.sampleRate : 0);
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
            dispatch_async(queue(), ^{ if (current == generation) { queuedFrames -= frames; completedFrames += frames; } });
        }];
        ok = true;
    }});
    return ok;
}

static AVAudioEngine *captureEngine;
static NSLock *captureLock;
static NSMutableData *captured;
static bool captureOverflow;

bool vv_capture_start(char *error, size_t capacity) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusNotDetermined) {
        if (![[NSBundle mainBundle] objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"]) {
            failure(error, capacity, @"microphone capture requires the packaged app's usage description");
            return false;
        }
        dispatch_semaphore_t answered = dispatch_semaphore_create(0);
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) { dispatch_semaphore_signal(answered); }];
        if (dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) != 0) {
            failure(error, capacity, @"microphone permission was not answered");
            return false;
        }
        status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    }
    if (status != AVAuthorizationStatusAuthorized) { failure(error, capacity, @"microphone permission was denied"); return false; }
    __block bool ok = false;
    dispatch_sync(queue(), ^{ @autoreleasepool {
        if (captureEngine) { failure(error, capacity, @"microphone capture is already active"); return; }
        static dispatch_once_t once;
        dispatch_once(&once, ^{ captureLock = [[NSLock alloc] init]; captured = [[NSMutableData alloc] init]; });
        [captureLock lock]; [captured setLength:0]; captureOverflow = false; [captureLock unlock];
        AVAudioEngine *engine = [[AVAudioEngine alloc] init];
        AVAudioInputNode *input = engine.inputNode;
        NSError *voiceProblem = nil;
        if (![input setVoiceProcessingEnabled:YES error:&voiceProblem]) { failure(error, capacity, voiceProblem.localizedDescription); return; }
        AVAudioFormat *source = [input outputFormatForBus:0];
        if (source.sampleRate <= 0 || source.channelCount == 0) { failure(error, capacity, @"no microphone input is available"); return; }
        AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:16000 channels:1];
        AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:source toFormat:format];
        if (!converter) { failure(error, capacity, @"microphone format conversion is unavailable"); return; }
        [input installTapOnBus:0 bufferSize:1024 format:source block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
            @autoreleasepool {
                AVAudioFrameCount count = (AVAudioFrameCount)ceil(buffer.frameLength * 16000.0 / source.sampleRate) + 16;
                AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:count];
                __block bool supplied = false;
                NSError *problem = nil;
                AVAudioConverterOutputStatus result = [converter convertToBuffer:output error:&problem withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *inputStatus) {
                    if (supplied) { *inputStatus = AVAudioConverterInputStatus_NoDataNow; return nil; }
                    supplied = true;
                    *inputStatus = AVAudioConverterInputStatus_HaveData;
                    return buffer;
                }];
                [captureLock lock];
                if (result == AVAudioConverterOutputStatus_Error || captured.length + output.frameLength * 2 > 16000 * 2 * 5) {
                    captureOverflow = true;
                } else if (!captureOverflow) {
                    for (AVAudioFrameCount i = 0; i < output.frameLength; i++) {
                        float value = fmaxf(-1.0f, fminf(1.0f, output.floatChannelData[0][i]));
                        int16_t sample = (int16_t)lrintf(value * 32767.0f);
                        unsigned char bytes[2] = { sample & 0xff, ((uint16_t)sample >> 8) & 0xff };
                        [captured appendBytes:bytes length:2];
                    }
                }
                [captureLock unlock];
            }
        }];
        NSError *problem = nil;
        if (![engine startAndReturnError:&problem]) {
            [input removeTapOnBus:0];
            failure(error, capacity, problem.localizedDescription);
            return;
        }
        captureEngine = engine;
        ok = true;
    }});
    return ok;
}

long vv_capture_read(unsigned char *bytes, size_t capacity) {
    if (!captureLock) return 0;
    [captureLock lock];
    if (captureOverflow) { [captureLock unlock]; return -1; }
    NSUInteger length = MIN(capacity, captured.length);
    // MOSS accepts complete 20 ms frames at 16 kHz.
    length -= length % 640;
    if (length) {
        memcpy(bytes, captured.bytes, length);
        [captured replaceBytesInRange:NSMakeRange(0, length) withBytes:NULL length:0];
    }
    [captureLock unlock];
    return (long)length;
}

void vv_capture_stop(void) {
    dispatch_sync(queue(), ^{ @autoreleasepool {
        if (captureEngine) {
            [captureEngine.inputNode removeTapOnBus:0];
            [captureEngine stop];
            captureEngine = nil;
        }
        [captureLock lock]; [captured setLength:0]; [captureLock unlock];
    }});
}

unsigned long long vv_pcm_completed(void) {
    __block unsigned long long frames = 0;
    dispatch_sync(queue(), ^{ frames = completedFrames; });
    return frames;
}
