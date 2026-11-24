import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_RAW_DIR = join(ROOT, "design", "pixel", "raw");
const DEFAULT_OUT_DIR = join(ROOT, "apps", "mac", "resources");

const ICON_SIZE = 1024;
const FALLBACK_SQUIRCLE_SIZE = 824;
const FALLBACK_SQUIRCLE_OFFSET = (ICON_SIZE - FALLBACK_SQUIRCLE_SIZE) / 2;

const DMG_W = 1360;
const DMG_H = 880;
const DMG_DPI = 144;

const ICONSET_SIZES: readonly { readonly filename: string; readonly dim: number }[] = [
  { filename: "icon_16x16.png", dim: 16 },
  { filename: "icon_16x16@2x.png", dim: 32 },
  { filename: "icon_32x32.png", dim: 32 },
  { filename: "icon_32x32@2x.png", dim: 64 },
  { filename: "icon_128x128.png", dim: 128 },
  { filename: "icon_128x128@2x.png", dim: 256 },
  { filename: "icon_256x256.png", dim: 256 },
  { filename: "icon_256x256@2x.png", dim: 512 },
  { filename: "icon_512x512.png", dim: 512 },
  { filename: "icon_512x512@2x.png", dim: 1024 },
];

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

interface ChannelBadge {
  readonly channel: string;
  readonly icnsName: string;
  readonly label?: string;
  readonly fillTop: Rgb;
  readonly fillBottom: Rgb;
  readonly border: Rgb;
  readonly highlight: Rgba;
  readonly textColor: Rgb;
  readonly width: number;
}

const CHANNELS: readonly ChannelBadge[] = [
  {
    channel: "release",
    icnsName: "icon.icns",
    fillTop: [0, 0, 0],
    fillBottom: [0, 0, 0],
    border: [0, 0, 0],
    highlight: [0, 0, 0, 0],
    textColor: [0, 0, 0],
    width: 0,
  },
  {
    channel: "alpha",
    icnsName: "icon-alpha.icns",
    label: "ALPHA",
    fillTop: [242, 166, 48],
    fillBottom: [216, 132, 24],
    border: [45, 30, 18],
    highlight: [255, 244, 212, 130],
    textColor: [45, 30, 18],
    width: 326,
  },
  {
    channel: "beta",
    icnsName: "icon-beta.icns",
    label: "BETA",
    fillTop: [74, 138, 201],
    fillBottom: [46, 102, 162],
    border: [22, 43, 69],
    highlight: [214, 236, 255, 115],
    textColor: [255, 255, 255],
    width: 284,
  },
  {
    channel: "dev",
    icnsName: "icon-dev.icns",
    label: "DEV",
    fillTop: [73, 95, 73],
    fillBottom: [47, 63, 47],
    border: [24, 34, 24],
    highlight: [208, 232, 208, 95],
    textColor: [247, 243, 232],
    width: 248,
  },
];

const SWIFT_RENDERER = String.raw`
import AppKit
import CoreGraphics
import CoreImage
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct ChannelSpec: Decodable {
    let channel: String
    let label: String?
    let fillTop: [Double]
    let fillBottom: [Double]
    let border: [Double]
    let highlight: [Double]
    let textColor: [Double]
    let width: Double
    let fullBleedOut: String
    let fallbackOut: String
}

struct RenderPlan: Decodable {
    let rawIcon: String
    let rawBg: String
    let dmgOut: String
    let iconSize: Int
    let squircleSize: Int
    let squircleOffset: Int
    let dmgW: Int
    let dmgH: Int
    let dmgDpi: Int
    let channels: [ChannelSpec]
}

func color(_ rgb: [Double], alpha: Double? = nil) -> CGColor {
    let a = alpha ?? (rgb.count > 3 ? rgb[3] / 255.0 : 1.0)
    return CGColor(srgbRed: rgb[0] / 255.0, green: rgb[1] / 255.0, blue: rgb[2] / 255.0, alpha: a)
}

func makeContext(width: Int, height: Int) -> CGContext {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    ctx.interpolationQuality = .high
    return ctx
}

func loadImage(_ path: String) -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        fputs("Failed to load image: \(path)\n", stderr)
        exit(1)
    }
    return img
}

func writePng(_ image: CGImage, to path: String, dpi: Int? = nil, opaqueRgb: Bool = false) {
    let finalImage: CGImage
    if opaqueRgb {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: nil,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        )!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        finalImage = ctx.makeImage()!
    } else {
        finalImage = image
    }

    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fputs("Failed to create PNG destination: \(path)\n", stderr)
        exit(1)
    }
    var props: [CFString: Any] = [:]
    if let dpi = dpi {
        props[kCGImagePropertyDPIWidth] = dpi
        props[kCGImagePropertyDPIHeight] = dpi
    }
    CGImageDestinationAddImage(dest, finalImage, props as CFDictionary)
    if !CGImageDestinationFinalize(dest) {
        fputs("Failed to finalize PNG: \(path)\n", stderr)
        exit(1)
    }
}

func resize(_ image: CGImage, width: Int, height: Int) -> CGImage {
    let ctx = makeContext(width: width, height: height)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return ctx.makeImage()!
}

func gaussianBlur(_ image: CGImage, radius: Double) -> CGImage {
    let ciInput = CIImage(cgImage: image)
    let filter = CIFilter(name: "CIGaussianBlur")!
    filter.setValue(ciInput, forKey: kCIInputImageKey)
    filter.setValue(radius, forKey: kCIInputRadiusKey)
    let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
    let extent = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    return ciContext.createCGImage(filter.outputImage!, from: extent)!
}

func drawRoundedRectPath(_ ctx: CGContext, rect: CGRect, radius: Double) {
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(path)
}

func badgeFont(sizePx: Double) -> CTFont {
    let candidates: [(String, String?)] = [
        ("/System/Library/Fonts/SFNSRounded.ttf", "Heavy"),
        ("/System/Library/Fonts/SFCompactRounded.ttf", "Heavy"),
        ("/System/Library/Fonts/SFNS.ttf", "Bold"),
        ("/System/Library/Fonts/Helvetica.ttc", nil),
    ]
    for (path, _) in candidates {
        if FileManager.default.fileExists(atPath: path) {
            let url = URL(fileURLWithPath: path) as CFURL
            if let descs = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor],
               let first = descs.first {
                let base = CTFontCreateWithFontDescriptor(first, sizePx, nil)
                if let bold = CTFontCreateCopyWithSymbolicTraits(base, sizePx, nil, .boldTrait, .boldTrait) {
                    return bold
                }
                return base
            }
        }
    }
    return CTFontCreateWithName("Helvetica-Bold" as CFString, sizePx, nil)
}

func applyChannelBadge(baseIcon: CGImage, spec: ChannelSpec, iconSize: Int) -> CGImage {
    guard let label = spec.label else {
        return baseIcon
    }
    let ss = 2.0
    let w = Int(Double(iconSize) * ss)
    let h = Int(Double(iconSize) * ss)

    let pillH = 122.0 * ss
    let pillW = spec.width * ss
    let x2 = 946.0 * ss
    let y2Top = 922.0 * ss
    let x1 = x2 - pillW
    // CoreGraphics origin is bottom-left.
    let cgY = Double(h) - y2Top
    let pillRect = CGRect(x: x1, y: cgY, width: pillW, height: pillH)
    let radius = pillH / 2.0
    let borderW = 5.0 * ss

    // Drop shadow layer.
    let shadowCtx = makeContext(width: w, height: h)
    shadowCtx.setFillColor(CGColor(srgbRed: 24.0 / 255.0, green: 16.0 / 255.0, blue: 10.0 / 255.0, alpha: 105.0 / 255.0))
    drawRoundedRectPath(shadowCtx, rect: CGRect(x: x1, y: cgY - 8.0 * ss, width: pillW, height: pillH), radius: radius)
    shadowCtx.fillPath()
    let blurredShadow = gaussianBlur(shadowCtx.makeImage()!, radius: 12.0 * ss)

    let canvas = makeContext(width: w, height: h)
    canvas.draw(blurredShadow, in: CGRect(x: 0, y: 0, width: w, height: h))

    // Gradient fill inside pill.
    canvas.saveGState()
    drawRoundedRectPath(canvas, rect: pillRect, radius: radius)
    canvas.clip()
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let gradient = CGGradient(
        colorsSpace: cs,
        colors: [color(spec.fillTop), color(spec.fillBottom)] as CFArray,
        locations: [0.0, 1.0]
    )!
    canvas.drawLinearGradient(
        gradient,
        start: CGPoint(x: x1, y: cgY + pillH),
        end: CGPoint(x: x1, y: cgY),
        options: []
    )
    canvas.restoreGState()

    // Subtle top inner highlight arc.
    let hiCtx = makeContext(width: Int(pillW), height: Int(pillH))
    let inset = borderW + 2.0 * ss
    hiCtx.setStrokeColor(color(spec.highlight))
    hiCtx.setLineWidth(2.0 * ss)
    drawRoundedRectPath(
        hiCtx,
        rect: CGRect(x: inset, y: inset, width: pillW - 2 * inset, height: pillH - 2 * inset),
        radius: max(1.0, radius - inset)
    )
    hiCtx.strokePath()
    if let hiImg = hiCtx.makeImage() {
        let maskedCtx = makeContext(width: Int(pillW), height: Int(pillH))
        let fadeGrad = CGGradient(
            colorsSpace: cs,
            colors: [
                CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
                CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0),
            ] as CFArray,
            locations: [0.0, 0.55]
        )!
        maskedCtx.drawLinearGradient(
            fadeGrad,
            start: CGPoint(x: 0, y: pillH),
            end: CGPoint(x: 0, y: 0),
            options: [.drawsAfterEndLocation]
        )
        if let maskImg = maskedCtx.makeImage() {
            let finalHi = makeContext(width: Int(pillW), height: Int(pillH))
            let bounds = CGRect(x: 0, y: 0, width: pillW, height: pillH)
            finalHi.clip(to: bounds, mask: maskImg)
            finalHi.draw(hiImg, in: bounds)
            if let composedHi = finalHi.makeImage() {
                canvas.draw(composedHi, in: pillRect)
            }
        }
    }

    // Dark outline.
    canvas.setStrokeColor(color(spec.border))
    canvas.setLineWidth(borderW)
    drawRoundedRectPath(
        canvas,
        rect: pillRect.insetBy(dx: borderW / 2.0, dy: borderW / 2.0),
        radius: max(1.0, radius - borderW / 2.0)
    )
    canvas.strokePath()

    // Bold tracked text centered optically inside the pill.
    let font = badgeFont(sizePx: 65.0 * ss)
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(cgColor: color(spec.textColor))!,
        .kern: 2.5 * ss,
    ]
    let attrStr = NSAttributedString(string: label, attributes: attrs)
    let line = CTLineCreateWithAttributedString(attrStr)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
    let textW = bounds.width
    let textH = bounds.height
    let centerX = x1 + pillW / 2.0
    let centerY = cgY + pillH / 2.0 + 1.0 * ss
    let drawX = centerX - textW / 2.0 - bounds.origin.x
    let drawY = centerY - textH / 2.0 - bounds.origin.y
    canvas.textPosition = CGPoint(x: drawX, y: drawY)
    CTLineDraw(line, canvas)

    let badge1x = resize(canvas.makeImage()!, width: iconSize, height: iconSize)
    let outCtx = makeContext(width: iconSize, height: iconSize)
    let fullRect = CGRect(x: 0, y: 0, width: iconSize, height: iconSize)
    outCtx.draw(baseIcon, in: fullRect)
    outCtx.draw(badge1x, in: fullRect)
    return outCtx.makeImage()!
}

func makeSquircleMask(size: Int, supersample: Int = 2, exponent: Double = 5.0) -> CGImage {
    let n = size * supersample
    let half = Double(n - 1) / 2.0
    let halfLen = (n + 1) / 2
    let invHalf = 1.0 / half
    var pows = [Double](repeating: 0.0, count: halfLen)
    for i in 0..<halfLen {
        pows[i] = pow(abs((Double(i) - half) * invHalf), exponent)
    }
    var bytes = [UInt8](repeating: 0, count: n * n * 4)
    for y in 0..<halfLen {
        let py = pows[y]
        let yMir = n - 1 - y
        for x in 0..<halfLen {
            let d = py + pows[x]
            let val: UInt8
            if d <= 0.992 {
                val = 255
            } else if d >= 1.008 {
                val = 0
            } else {
                val = UInt8(max(0, min(255, Int((255.0 * (1.008 - d) / 0.016).rounded()))))
            }
            if val > 0 {
                let xMir = n - 1 - x
                for (px, pyCoord) in [(x, y), (xMir, y), (x, yMir), (xMir, yMir)] {
                    let idx = (pyCoord * n + px) * 4
                    bytes[idx] = val
                    bytes[idx + 1] = val
                    bytes[idx + 2] = val
                    bytes[idx + 3] = val
                }
            }
        }
    }
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(
        data: &bytes,
        width: n,
        height: n,
        bitsPerComponent: 8,
        bytesPerRow: n * 4,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    return resize(ctx.makeImage()!, width: size, height: size)
}

func renderFallbackSquircle(fullBleed: CGImage, squircleMask: CGImage, iconSize: Int, sqSize: Int, offset: Int) -> CGImage {
    let inner = resize(fullBleed, width: sqSize, height: sqSize)
    let maskedCtx = makeContext(width: sqSize, height: sqSize)
    let innerRect = CGRect(x: 0, y: 0, width: sqSize, height: sqSize)
    maskedCtx.clip(to: innerRect, mask: squircleMask)
    maskedCtx.draw(inner, in: innerRect)
    let masked = maskedCtx.makeImage()!

    // Dock drop shadow.
    let shadowCtx = makeContext(width: iconSize, height: iconSize)
    let cgShadowY = Double(iconSize - offset - sqSize - 12)
    let shadowRect = CGRect(x: Double(offset), y: cgShadowY, width: Double(sqSize), height: Double(sqSize))
    shadowCtx.saveGState()
    shadowCtx.clip(to: shadowRect, mask: squircleMask)
    shadowCtx.setFillColor(CGColor(srgbRed: 18.0 / 255.0, green: 12.0 / 255.0, blue: 6.0 / 255.0, alpha: 0.28))
    shadowCtx.fill(shadowRect)
    shadowCtx.restoreGState()
    let blurredShadow = gaussianBlur(shadowCtx.makeImage()!, radius: 22.0)

    let outCtx = makeContext(width: iconSize, height: iconSize)
    outCtx.draw(blurredShadow, in: CGRect(x: 0, y: 0, width: iconSize, height: iconSize))
    outCtx.draw(masked, in: CGRect(x: offset, y: iconSize - offset - sqSize, width: sqSize, height: sqSize))
    return outCtx.makeImage()!
}

func drawCapsule(_ ctx: CGContext, from p0: CGPoint, to p1: CGPoint, width: Double, color: CGColor) {
    ctx.setStrokeColor(color)
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.beginPath()
    ctx.move(to: p0)
    ctx.addLine(to: p1)
    ctx.strokePath()
}

func buildDmgBackground(rawBgPath: String, dest: String, dmgW: Int, dmgH: Int, dpi: Int) {
    let raw = loadImage(rawBgPath)
    let scaledH = Int((Double(raw.height) * (Double(dmgW) / Double(raw.width))).rounded())
    let scaled = resize(raw, width: dmgW, height: scaledH)

    let canvas = makeContext(width: dmgW, height: dmgH)
    // Top 1px strip stretched vertically across the canvas (CGImage.cropping uses top-left origin).
    if let topStrip = scaled.cropping(to: CGRect(x: 0, y: 0, width: dmgW, height: 1)) {
        canvas.draw(topStrip, in: CGRect(x: 0, y: 0, width: dmgW, height: dmgH))
    }

    let shiftDown = 88
    let cropH = dmgH - shiftDown
    if let croppedLand = scaled.cropping(to: CGRect(x: 0, y: 0, width: dmgW, height: cropH)) {
        // Feather top 48px of shifted artwork.
        let feather = 48
        let maskCtx = makeContext(width: dmgW, height: cropH)
        maskCtx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        maskCtx.fill(CGRect(x: 0, y: 0, width: dmgW, height: cropH - feather))
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let grad = CGGradient(
            colorsSpace: cs,
            colors: [
                CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0),
                CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1),
            ] as CFArray,
            locations: [0.0, 1.0]
        )!
        maskCtx.drawLinearGradient(
            grad,
            start: CGPoint(x: 0, y: Double(cropH)),
            end: CGPoint(x: 0, y: Double(cropH - feather)),
            options: []
        )
        if let maskImg = maskCtx.makeImage() {
            let landRect = CGRect(x: 0, y: 0, width: dmgW, height: cropH)
            canvas.saveGState()
            canvas.clip(to: landRect, mask: maskImg)
            canvas.draw(croppedLand, in: landRect)
            canvas.restoreGState()
        }
    }

    // Subtle atmospheric veil across upper 520px.
    for yTop in 0..<520 {
        let alpha = (24.0 * pow(1.0 - Double(yTop) / 520.0, 1.3)).rounded() / 255.0
        canvas.setFillColor(CGColor(srgbRed: 1.0, green: 251.0 / 255.0, blue: 240.0 / 255.0, alpha: alpha))
        canvas.fill(CGRect(x: 0, y: dmgH - 1 - yTop, width: dmgW, height: 1))
    }

    let ss = 2.0
    let ow = Int(Double(dmgW) * ss)
    let oh = Int(Double(dmgH) * ss)
    let overlay = makeContext(width: ow, height: oh)

    let zoneSize = 340.0 * ss
    let zoneRadius = 44.0 * ss
    for (cx, cyTop) in [(360.0, 420.0), (1000.0, 420.0)] {
        let x1 = cx * ss - zoneSize / 2.0
        let cgY = Double(oh) - (cyTop * ss + zoneSize / 2.0)
        let cardRect = CGRect(x: x1, y: cgY, width: zoneSize, height: zoneSize)

        let shadowCtx = makeContext(width: ow, height: oh)
        shadowCtx.setFillColor(CGColor(srgbRed: 96.0 / 255.0, green: 74.0 / 255.0, blue: 48.0 / 255.0, alpha: 26.0 / 255.0))
        drawRoundedRectPath(shadowCtx, rect: CGRect(x: x1, y: cgY - 6.0 * ss, width: zoneSize, height: zoneSize), radius: zoneRadius)
        shadowCtx.fillPath()
        overlay.draw(gaussianBlur(shadowCtx.makeImage()!, radius: 14.0 * ss), in: CGRect(x: 0, y: 0, width: ow, height: oh))

        overlay.setFillColor(CGColor(srgbRed: 1.0, green: 250.0 / 255.0, blue: 238.0 / 255.0, alpha: 148.0 / 255.0))
        drawRoundedRectPath(overlay, rect: cardRect, radius: zoneRadius)
        overlay.fillPath()

        let glowInset = 3.0 * ss
        overlay.setStrokeColor(CGColor(srgbRed: 1.0, green: 253.0 / 255.0, blue: 247.0 / 255.0, alpha: 130.0 / 255.0))
        overlay.setLineWidth(3.0 * ss)
        drawRoundedRectPath(overlay, rect: cardRect.insetBy(dx: glowInset, dy: glowInset), radius: max(1.0, zoneRadius - glowInset))
        overlay.strokePath()

        overlay.setStrokeColor(CGColor(srgbRed: 122.0 / 255.0, green: 102.0 / 255.0, blue: 74.0 / 255.0, alpha: 72.0 / 255.0))
        overlay.setLineWidth(2.0 * ss)
        drawRoundedRectPath(overlay, rect: cardRect.insetBy(dx: ss, dy: ss), radius: max(1.0, zoneRadius - ss))
        overlay.strokePath()
    }

    // Center arrow pill at (680, 420).
    let acx = 680.0 * ss
    let acyCg = Double(oh) - 420.0 * ss
    let pillW = 116.0 * ss
    let pillH = 76.0 * ss
    let px1 = acx - pillW / 2.0
    let py1Cg = acyCg - pillH / 2.0
    let pr = pillH / 2.0
    let arrowRect = CGRect(x: px1, y: py1Cg, width: pillW, height: pillH)

    let aShadowCtx = makeContext(width: ow, height: oh)
    aShadowCtx.setFillColor(CGColor(srgbRed: 96.0 / 255.0, green: 74.0 / 255.0, blue: 48.0 / 255.0, alpha: 36.0 / 255.0))
    drawRoundedRectPath(aShadowCtx, rect: CGRect(x: px1, y: py1Cg - 5.0 * ss, width: pillW, height: pillH), radius: pr)
    aShadowCtx.fillPath()
    overlay.draw(gaussianBlur(aShadowCtx.makeImage()!, radius: 10.0 * ss), in: CGRect(x: 0, y: 0, width: ow, height: oh))

    overlay.setFillColor(CGColor(srgbRed: 1.0, green: 250.0 / 255.0, blue: 238.0 / 255.0, alpha: 206.0 / 255.0))
    drawRoundedRectPath(overlay, rect: arrowRect, radius: pr)
    overlay.fillPath()

    overlay.setStrokeColor(CGColor(srgbRed: 122.0 / 255.0, green: 102.0 / 255.0, blue: 74.0 / 255.0, alpha: 88.0 / 255.0))
    overlay.setLineWidth(2.0 * ss)
    drawRoundedRectPath(overlay, rect: arrowRect.insetBy(dx: ss, dy: ss), radius: max(1.0, pr - ss))
    overlay.strokePath()

    overlay.setStrokeColor(CGColor(srgbRed: 1.0, green: 254.0 / 255.0, blue: 249.0 / 255.0, alpha: 140.0 / 255.0))
    overlay.setLineWidth(2.0 * ss)
    drawRoundedRectPath(overlay, rect: arrowRect.insetBy(dx: 3.0 * ss, dy: 3.0 * ss), radius: max(1.0, pr - 3.0 * ss))
    overlay.strokePath()

    let ink = CGColor(srgbRed: 107.0 / 255.0, green: 78.0 / 255.0, blue: 49.0 / 255.0, alpha: 235.0 / 255.0)
    let stroke = 7.0 * ss
    drawCapsule(overlay, from: CGPoint(x: acx - 24.0 * ss, y: acyCg), to: CGPoint(x: acx + 20.0 * ss, y: acyCg), width: stroke, color: ink)
    drawCapsule(overlay, from: CGPoint(x: acx + 6.0 * ss, y: acyCg + 16.0 * ss), to: CGPoint(x: acx + 24.0 * ss, y: acyCg), width: stroke, color: ink)
    drawCapsule(overlay, from: CGPoint(x: acx + 6.0 * ss, y: acyCg - 16.0 * ss), to: CGPoint(x: acx + 24.0 * ss, y: acyCg), width: stroke, color: ink)

    let overlay1x = resize(overlay.makeImage()!, width: dmgW, height: dmgH)
    canvas.draw(overlay1x, in: CGRect(x: 0, y: 0, width: dmgW, height: dmgH))
    writePng(canvas.makeImage()!, to: dest, dpi: dpi, opaqueRgb: true)
}

let planData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let plan = try JSONDecoder().decode(RenderPlan.self, from: planData)
let baseIcon = resize(loadImage(plan.rawIcon), width: plan.iconSize, height: plan.iconSize)
let squircleMask = makeSquircleMask(size: plan.squircleSize)

for spec in plan.channels {
    let fullBleed = applyChannelBadge(baseIcon: baseIcon, spec: spec, iconSize: plan.iconSize)
    writePng(fullBleed, to: spec.fullBleedOut, opaqueRgb: true)
    let fallback = renderFallbackSquircle(
        fullBleed: fullBleed,
        squircleMask: squircleMask,
        iconSize: plan.iconSize,
        sqSize: plan.squircleSize,
        offset: plan.squircleOffset
    )
    writePng(fallback, to: spec.fallbackOut)
}

buildDmgBackground(rawBgPath: plan.rawBg, dest: plan.dmgOut, dmgW: plan.dmgW, dmgH: plan.dmgH, dpi: plan.dmgDpi)
`;

function buildIcns(fallbackPng: string, dest: string): void {
  const work = mkdtempSync(join(tmpdir(), "vv-iconset-"));
  const iconset = join(work, "AppIcon.iconset");
  try {
    mkdirSync(iconset);
    for (const slot of ICONSET_SIZES) {
      execFileSync("sips", ["-z", String(slot.dim), String(slot.dim), fallbackPng, "--out", join(iconset, slot.filename)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", dest], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function generateMacBranding(rawDir = DEFAULT_RAW_DIR, outDir = DEFAULT_OUT_DIR): number {
  const rawIcon = join(rawDir, "app-icon.png");
  const rawBg = join(rawDir, "dmg-background.png");
  for (const required of [rawIcon, rawBg]) {
    if (!existsSync(required)) {
      console.error(`Missing raw asset: ${required}. Run ./design/art.sh first.`);
      return 1;
    }
  }

  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "vv-branding-"));
  try {
    const swiftPath = join(work, "render.swift");
    const planPath = join(work, "plan.json");
    writeFileSync(swiftPath, SWIFT_RENDERER);

    const channels = CHANNELS.map((spec) => ({
      channel: spec.channel,
      label: spec.label ?? null,
      fillTop: spec.fillTop,
      fillBottom: spec.fillBottom,
      border: spec.border,
      highlight: spec.highlight,
      textColor: spec.textColor,
      width: spec.width,
      fullBleedOut: join(outDir, `appicon-${spec.channel}.png`),
      fallbackOut: join(work, `fallback-${spec.channel}.png`),
    }));

    const dmgDest = join(outDir, "dmg-background.png");
    writeFileSync(
      planPath,
      JSON.stringify({
        rawIcon,
        rawBg,
        dmgOut: dmgDest,
        iconSize: ICON_SIZE,
        squircleSize: FALLBACK_SQUIRCLE_SIZE,
        squircleOffset: FALLBACK_SQUIRCLE_OFFSET,
        dmgW: DMG_W,
        dmgH: DMG_H,
        dmgDpi: DMG_DPI,
        channels,
      }),
    );

    execFileSync("swift", [swiftPath, planPath], { stdio: ["ignore", "inherit", "inherit"] });

    for (const spec of CHANNELS) {
      const pngPath = join(outDir, `appicon-${spec.channel}.png`);
      const fallbackPng = join(work, `fallback-${spec.channel}.png`);
      const icnsPath = join(outDir, spec.icnsName);
      buildIcns(fallbackPng, icnsPath);
      console.log(`Generated ${relative(ROOT, pngPath)} and ${relative(ROOT, icnsPath)}`);
    }

    console.log(`Generated ${relative(ROOT, dmgDest)} (${DMG_W}x${DMG_H} @${DMG_DPI} DPI)`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "raw-dir": { type: "string" },
      "out-dir": { type: "string" },
    },
  });
  process.exitCode = generateMacBranding(values["raw-dir"] ?? DEFAULT_RAW_DIR, values["out-dir"] ?? DEFAULT_OUT_DIR);
}
