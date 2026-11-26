#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <math.h>

typedef void (*vv_webview_snapshot_cb)(
    void *ctx,
    const unsigned char *rgba,
    unsigned int width,
    unsigned int height,
    const char *error
);

static void find_largest_visible_webview_rec(NSView *view, WKWebView *__strong *best, double *best_area) {
    if (!view || view.isHidden || view.alphaValue <= 0.01) {
        return;
    }
    if ([view isKindOfClass:[WKWebView class]]) {
        CGRect bounds = view.bounds;
        if (bounds.size.width >= 32.0 && bounds.size.height >= 32.0) {
            double area = (double)bounds.size.width * (double)bounds.size.height;
            if (area > *best_area) {
                *best_area = area;
                *best = (WKWebView *)view;
            }
        }
        return;
    }
    for (NSView *child in view.subviews) {
        find_largest_visible_webview_rec(child, best, best_area);
    }
}

static WKWebView *find_largest_visible_webview(NSView *root) {
    WKWebView *best = nil;
    double best_area = 0.0;
    find_largest_visible_webview_rec(root, &best, &best_area);
    return best;
}

void vv_capture_webview_snapshot(
    void *parent_ns_view,
    double target_width,
    double target_height,
    vv_webview_snapshot_cb callback,
    void *ctx
) {
    if (!callback) {
        return;
    }
    if (![NSThread isMainThread]) {
        callback(ctx, NULL, 0, 0, "webview capture must run on the main thread");
        return;
    }
    if (!parent_ns_view) {
        callback(ctx, NULL, 0, 0, "window view is unavailable");
        return;
    }

    @autoreleasepool {
        NSView *root = (__bridge NSView *)parent_ns_view;
        NSWindow *window = root.window;
        if (!window || window.isMiniaturized || !window.isVisible) {
            callback(ctx, NULL, 0, 0, "window is not visible");
            return;
        }

        WKWebView *webview = find_largest_visible_webview(root);
        if (!webview || webview.isHiddenOrHasHiddenAncestor) {
            callback(ctx, NULL, 0, 0, "no visible webview");
            return;
        }

        CGSize size = webview.bounds.size;
        if (size.width < 32.0 || size.height < 32.0) {
            callback(ctx, NULL, 0, 0, "webview bounds too small");
            return;
        }

        double safe_w = fmin(fmax(target_width, 64.0), 1280.0);
        double safe_h = fmin(fmax(target_height, 64.0), 800.0);
        double aspect = (double)size.width / (double)size.height;
        double needed_w = fmax(safe_w, safe_h * aspect);
        double max_w_for_height = 2048.0 * aspect;
        double capture_w = fmin(fmax(needed_w, 64.0), fmin(1600.0, fmax(max_w_for_height, 64.0)));

        WKSnapshotConfiguration *config = [[WKSnapshotConfiguration alloc] init];
        config.rect = CGRectNull;
        config.snapshotWidth = @(capture_w);
        config.afterScreenUpdates = YES;

        [webview takeSnapshotWithConfiguration:config completionHandler:^(NSImage *snapshotImage, NSError *error) {
            @autoreleasepool {
                if (error != nil) {
                    const char *msg = error.localizedDescription.UTF8String ?: "webview snapshot failed";
                    callback(ctx, NULL, 0, 0, msg);
                    return;
                }
                if (!snapshotImage) {
                    callback(ctx, NULL, 0, 0, "empty webview snapshot");
                    return;
                }

                CGImageRef cgImage = [snapshotImage CGImageForProposedRect:NULL context:nil hints:nil];
                if (!cgImage) {
                    callback(ctx, NULL, 0, 0, "could not read snapshot bitmap");
                    return;
                }

                size_t width = CGImageGetWidth(cgImage);
                size_t height = CGImageGetHeight(cgImage);
                if (width == 0 || height == 0 || width > 8192 || height > 8192) {
                    callback(ctx, NULL, 0, 0, "snapshot dimensions out of bounds");
                    return;
                }

                size_t byte_count = width * height * 4;
                NSMutableData *rgba = [NSMutableData dataWithLength:byte_count];
                if (!rgba) {
                    callback(ctx, NULL, 0, 0, "out of memory for snapshot");
                    return;
                }

                CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
                if (!colorSpace) {
                    callback(ctx, NULL, 0, 0, "sRGB color space unavailable");
                    return;
                }

                CGBitmapInfo bitmapInfo = (CGBitmapInfo)kCGImageAlphaPremultipliedLast | (CGBitmapInfo)kCGBitmapByteOrder32Big;
                CGContextRef bitmapCtx = CGBitmapContextCreate(rgba.mutableBytes, width, height, 8, width * 4, colorSpace, bitmapInfo);
                CGColorSpaceRelease(colorSpace);
                if (!bitmapCtx) {
                    callback(ctx, NULL, 0, 0, "failed to create bitmap context");
                    return;
                }

                CGContextSetBlendMode(bitmapCtx, kCGBlendModeCopy);
                CGContextDrawImage(bitmapCtx, CGRectMake(0, 0, (CGFloat)width, (CGFloat)height), cgImage);
                CGContextRelease(bitmapCtx);

                callback(ctx, (const unsigned char *)rgba.bytes, (unsigned int)width, (unsigned int)height, NULL);
            }
        }];
    }
}
