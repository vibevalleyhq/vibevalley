import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const ASSETS_REPO = process.env.VIBEVALLEY_ASSETS_REPO ? resolve(process.env.VIBEVALLEY_ASSETS_REPO) : resolve(ROOT, "..", "vibevalley-assets");
const DEFAULT_RAW_DIR = join(ASSETS_REPO, "dist", "brand");
const DEFAULT_OUT_DIR = join(ROOT, "apps", "mac", "resources");

const FAVICON_SIZES: readonly number[] = [32, 64, 256];

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
    fillTop: [236, 179, 71],
    fillBottom: [215, 152, 42],
    border: [78, 59, 41],
    highlight: [255, 248, 224, 155],
    textColor: [56, 39, 24],
    width: 326,
  },
  {
    channel: "beta",
    icnsName: "icon-beta.icns",
    label: "BETA",
    fillTop: [106, 171, 180],
    fillBottom: [80, 144, 153],
    border: [78, 59, 41],
    highlight: [228, 247, 249, 140],
    textColor: [250, 244, 230],
    width: 284,
  },
  {
    channel: "dev",
    icnsName: "icon-dev.icns",
    label: "DEV",
    fillTop: [128, 173, 81],
    fillBottom: [100, 143, 56],
    border: [78, 59, 41],
    highlight: [228, 245, 202, 140],
    textColor: [250, 244, 230],
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
    let rawIcon: String?
    let rawBg: String?
    let dmgOnly: Bool?
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
    // Papertrails folded cardstock tab radius (soft tactile corners matching mount slots)
    let radius = 34.0 * ss
    let borderW = 5.5 * ss

    // Warm sepia drop shadow layer (#5B432B).
    let shadowCtx = makeContext(width: w, height: h)
    shadowCtx.setFillColor(CGColor(srgbRed: 91.0 / 255.0, green: 67.0 / 255.0, blue: 43.0 / 255.0, alpha: 118.0 / 255.0))
    drawRoundedRectPath(shadowCtx, rect: CGRect(x: x1 + 2.0 * ss, y: cgY - 8.0 * ss, width: pillW, height: pillH), radius: radius)
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

func hexColor(_ hex: UInt32, alpha: Double = 1.0) -> CGColor {
    let r = Double((hex >> 16) & 0xFF) / 255.0
    let g = Double((hex >> 8) & 0xFF) / 255.0
    let b = Double(hex & 0xFF) / 255.0
    return CGColor(srgbRed: r, green: g, blue: b, alpha: alpha)
}

func drawPaperShape(
    _ ctx: CGContext,
    w: Int,
    h: Int,
    path: CGPath,
    fill: CGColor,
    highlight: CGColor? = nil,
    outline: CGColor? = nil,
    lineWidth: Double = 2.0,
    shadowOffset: CGSize = CGSize(width: 2.0, height: -5.0),
    shadowBlur: Double = 10.0,
    shadowAlpha: Double = 0.18
) {
    if shadowAlpha > 0.001 {
        let sCtx = makeContext(width: w, height: h)
        sCtx.translateBy(x: shadowOffset.width, y: shadowOffset.height)
        sCtx.addPath(path)
        sCtx.setFillColor(hexColor(0x5B432B, alpha: shadowAlpha))
        sCtx.fillPath()
        ctx.draw(gaussianBlur(sCtx.makeImage()!, radius: shadowBlur), in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setFillColor(fill)
    ctx.fillPath()
    if let highlight = highlight {
        ctx.addPath(path)
        ctx.clip()
        ctx.translateBy(x: 2.0, y: -2.0)
        ctx.addPath(path)
        ctx.setStrokeColor(highlight)
        ctx.setLineWidth(lineWidth * 1.35)
        ctx.strokePath()
    }
    ctx.restoreGState()
    if let outline = outline {
        ctx.addPath(path)
        ctx.setStrokeColor(outline)
        ctx.setLineWidth(lineWidth)
        ctx.setLineJoin(.round)
        ctx.strokePath()
    }
}

func drawPaperCloud(_ ctx: CGContext, w: Int, h: Int, cx: Double, cy: Double, scale: Double) {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: cx - 58 * scale, y: cy - 14 * scale))
    p.addQuadCurve(to: CGPoint(x: cx - 54 * scale, y: cy + 12 * scale), control: CGPoint(x: cx - 72 * scale, y: cy - 2 * scale))
    p.addQuadCurve(to: CGPoint(x: cx - 22 * scale, y: cy + 28 * scale), control: CGPoint(x: cx - 46 * scale, y: cy + 32 * scale))
    p.addQuadCurve(to: CGPoint(x: cx + 26 * scale, y: cy + 26 * scale), control: CGPoint(x: cx + 2 * scale, y: cy + 44 * scale))
    p.addQuadCurve(to: CGPoint(x: cx + 56 * scale, y: cy + 6 * scale), control: CGPoint(x: cx + 50 * scale, y: cy + 24 * scale))
    p.addQuadCurve(to: CGPoint(x: cx + 56 * scale, y: cy - 14 * scale), control: CGPoint(x: cx + 70 * scale, y: cy - 4 * scale))
    p.closeSubpath()
    drawPaperShape(
        ctx,
        w: w,
        h: h,
        path: p,
        fill: hexColor(0xFDF9F0, alpha: 0.94),
        highlight: hexColor(0xFFFFFF, alpha: 0.85),
        outline: hexColor(0xB8A487, alpha: 0.36),
        lineWidth: 1.8 * scale,
        shadowOffset: CGSize(width: 2.0, height: -5.0 * scale),
        shadowBlur: 7.0 * scale,
        shadowAlpha: 0.08
    )
}

func drawPaperMountSlot(_ ctx: CGContext, ow: Int, oh: Int, ss: Double, cx: Double, cyTop: Double) {
    let outerSize = 336.0 * ss
    let outerR = 44.0 * ss
    let x1 = cx * ss - outerSize / 2.0
    let y1 = Double(oh) - (cyTop * ss + outerSize / 2.0)
    let outerRect = CGRect(x: x1, y: y1, width: outerSize, height: outerSize)
    let outerPath = CGPath(roundedRect: outerRect, cornerWidth: outerR, cornerHeight: outerR, transform: nil)

    drawPaperShape(
        ctx,
        w: ow,
        h: oh,
        path: outerPath,
        fill: hexColor(0xFAF4E6, alpha: 0.92),
        highlight: hexColor(0xFFFFFF, alpha: 0.9),
        outline: hexColor(0x7C6447, alpha: 0.42),
        lineWidth: 2.2 * ss,
        shadowOffset: CGSize(width: 0.0, height: -7.0 * ss),
        shadowBlur: 14.0 * ss,
        shadowAlpha: 0.16
    )

    // Recessed die-cut linen well
    let inset = 15.0 * ss
    let innerRect = outerRect.insetBy(dx: inset, dy: inset)
    let innerR = outerR - inset * 0.72
    let innerPath = CGPath(roundedRect: innerRect, cornerWidth: innerR, cornerHeight: innerR, transform: nil)
    ctx.saveGState()
    ctx.addPath(innerPath)
    ctx.setFillColor(hexColor(0xEFE5D1, alpha: 0.95))
    ctx.fillPath()
    ctx.addPath(innerPath)
    ctx.clip()
    ctx.setStrokeColor(hexColor(0x70583C, alpha: 0.20))
    ctx.setLineWidth(4.0 * ss)
    ctx.translateBy(x: 1.5 * ss, y: -2.0 * ss)
    ctx.addPath(innerPath)
    ctx.strokePath()
    ctx.restoreGState()

    ctx.addPath(innerPath)
    ctx.setStrokeColor(hexColor(0xFFFDF8, alpha: 0.65))
    ctx.setLineWidth(1.5 * ss)
    ctx.strokePath()

    // Corner crop-registration ticks (archival print plate feel)
    let tick = 10.0 * ss
    let pad = 9.0 * ss
    ctx.setStrokeColor(hexColor(0x8D7352, alpha: 0.36))
    ctx.setLineWidth(1.5 * ss)
    let corners: [(Double, Double, Double, Double)] = [
        (outerRect.minX - pad, outerRect.maxY + pad, 1, -1),
        (outerRect.maxX + pad, outerRect.maxY + pad, -1, -1),
        (outerRect.minX - pad, outerRect.minY - pad, 1, 1),
        (outerRect.maxX + pad, outerRect.minY - pad, -1, 1),
    ]
    for (kx, ky, dx, dy) in corners {
        ctx.beginPath()
        ctx.move(to: CGPoint(x: kx, y: ky + dy * tick))
        ctx.addLine(to: CGPoint(x: kx, y: ky))
        ctx.addLine(to: CGPoint(x: kx + dx * tick, y: ky))
        ctx.strokePath()
    }
}

func drawJiangnanPavilion(_ ctx: CGContext, ow: Int, oh: Int, ss: Double, cx: Double, baseY: Double, scale: Double, facingRight: Bool) {
    let s = ss * scale
    let dir = facingRight ? 1.0 : -1.0
    // Whitewashed plaster body
    let wallW = 114.0 * s
    let wallH = 82.0 * s
    let wallRect = CGRect(x: cx - wallW / 2.0, y: baseY, width: wallW, height: wallH)
    let wallPath = CGPath(roundedRect: wallRect, cornerWidth: 3.0 * s, cornerHeight: 3.0 * s, transform: nil)
    drawPaperShape(
        ctx,
        w: ow,
        h: oh,
        path: wallPath,
        fill: hexColor(0xFAF4E6),
        highlight: hexColor(0xFFFFFF, alpha: 0.7),
        outline: hexColor(0x4E3B29, alpha: 0.78),
        lineWidth: 2.0 * s,
        shadowOffset: CGSize(width: 4.0 * s * dir, height: -4.0 * s),
        shadowBlur: 7.0 * s,
        shadowAlpha: 0.22
    )

    // Timber frame pillars & beam
    let timber = hexColor(0x633E24)
    ctx.setFillColor(timber)
    ctx.fill(CGRect(x: wallRect.minX + 7.0 * s, y: baseY, width: 6.0 * s, height: wallH - 4.0 * s))
    ctx.fill(CGRect(x: wallRect.maxX - 13.0 * s, y: baseY, width: 6.0 * s, height: wallH - 4.0 * s))
    ctx.fill(CGRect(x: wallRect.minX + 5.0 * s, y: baseY + wallH * 0.48, width: wallW - 10.0 * s, height: 5.5 * s))

    // Glowing amber lattice windows
    for wx in [cx - 26.0 * s, cx + 8.0 * s] {
        let win = CGRect(x: wx, y: baseY + wallH * 0.57, width: 18.0 * s, height: 18.0 * s)
        ctx.setFillColor(hexColor(0xF6CE6C))
        ctx.fill(win)
        ctx.setStrokeColor(hexColor(0x5B3920))
        ctx.setLineWidth(1.6 * s)
        ctx.stroke(win)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: win.midX, y: win.minY))
        ctx.addLine(to: CGPoint(x: win.midX, y: win.maxY))
        ctx.move(to: CGPoint(x: win.minX, y: win.midY))
        ctx.addLine(to: CGPoint(x: win.maxX, y: win.midY))
        ctx.strokePath()
    }
    // Lower arched doorway
    let door = CGRect(x: cx - 14.0 * s, y: baseY + 2.0 * s, width: 28.0 * s, height: 32.0 * s)
    let doorPath = CGPath(roundedRect: door, cornerWidth: 10.0 * s, cornerHeight: 10.0 * s, transform: nil)
    ctx.addPath(doorPath)
    ctx.setFillColor(hexColor(0x8C5832))
    ctx.fillPath()
    ctx.addPath(doorPath)
    ctx.setStrokeColor(hexColor(0x472C19))
    ctx.setLineWidth(1.6 * s)
    ctx.strokePath()

    // Sweeping slate tile gable roof with upturned eaves
    let roof = CGMutablePath()
    let ry0 = baseY + wallH - 6.0 * s
    roof.move(to: CGPoint(x: cx - 74.0 * s, y: ry0 + 6.0 * s))
    roof.addQuadCurve(to: CGPoint(x: cx - 42.0 * s, y: ry0 + 18.0 * s), control: CGPoint(x: cx - 64.0 * s, y: ry0 - 1.0 * s))
    roof.addLine(to: CGPoint(x: cx, y: ry0 + 46.0 * s))
    roof.addLine(to: CGPoint(x: cx + 42.0 * s, y: ry0 + 18.0 * s))
    roof.addQuadCurve(to: CGPoint(x: cx + 74.0 * s, y: ry0 + 6.0 * s), control: CGPoint(x: cx + 64.0 * s, y: ry0 - 1.0 * s))
    roof.addLine(to: CGPoint(x: cx + 58.0 * s, y: ry0 - 5.0 * s))
    roof.addLine(to: CGPoint(x: cx - 58.0 * s, y: ry0 - 5.0 * s))
    roof.closeSubpath()
    drawPaperShape(
        ctx,
        w: ow,
        h: oh,
        path: roof,
        fill: hexColor(0x384654),
        highlight: hexColor(0x738799, alpha: 0.75),
        outline: hexColor(0x252E38),
        lineWidth: 2.0 * s,
        shadowOffset: CGSize(width: 2.0 * s, height: -5.0 * s),
        shadowBlur: 6.0 * s,
        shadowAlpha: 0.25
    )

    // Roof tile ribs
    ctx.setStrokeColor(hexColor(0x5E7080, alpha: 0.48))
    ctx.setLineWidth(1.3 * s)
    for k in -3...3 {
        let bx = cx + Double(k) * 14.0 * s
        ctx.beginPath()
        ctx.move(to: CGPoint(x: cx + Double(k) * 4.5 * s, y: ry0 + 38.0 * s))
        ctx.addLine(to: CGPoint(x: bx, y: ry0 - 2.0 * s))
        ctx.strokePath()
    }
}

func drawPaperLantern(_ ctx: CGContext, ow: Int, oh: Int, ss: Double, x: Double, postBottomY: Double, y: Double, scale: Double) {
    let s = ss * scale
    // Timber lantern post rooted on bridge parapet
    let post = CGPath(roundedRect: CGRect(x: x - 2.0 * s, y: postBottomY, width: 4.0 * s, height: (y - postBottomY) + 14.0 * s), cornerWidth: 1.5 * s, cornerHeight: 1.5 * s, transform: nil)
    ctx.addPath(post)
    ctx.setFillColor(hexColor(0x5A3A22))
    ctx.fillPath()
    let arm = CGPath(roundedRect: CGRect(x: x - 5.0 * s, y: y + 11.0 * s, width: 10.0 * s, height: 3.5 * s), cornerWidth: 1.5 * s, cornerHeight: 1.5 * s, transform: nil)
    ctx.addPath(arm)
    ctx.setFillColor(hexColor(0x472D19))
    ctx.fillPath()

    // Soft warm amber paper glow
    let glow = CGMutablePath()
    glow.addEllipse(in: CGRect(x: x - 20 * s, y: y - 20 * s, width: 40 * s, height: 40 * s))
    let gCtx = makeContext(width: ow, height: oh)
    gCtx.addPath(glow)
    gCtx.setFillColor(hexColor(0xF89E44, alpha: 0.44))
    gCtx.fillPath()
    ctx.draw(gaussianBlur(gCtx.makeImage()!, radius: 10 * s), in: CGRect(x: 0, y: 0, width: ow, height: oh))

    let cord = CGMutablePath()
    cord.move(to: CGPoint(x: x, y: y + 6 * s))
    cord.addLine(to: CGPoint(x: x, y: y + 13 * s))
    ctx.addPath(cord)
    ctx.setStrokeColor(hexColor(0x4E3622))
    ctx.setLineWidth(1.6 * s)
    ctx.strokePath()

    let body = CGPath(roundedRect: CGRect(x: x - 7.5 * s, y: y - 7 * s, width: 15 * s, height: 16 * s), cornerWidth: 6 * s, cornerHeight: 6 * s, transform: nil)
    ctx.addPath(body)
    ctx.setFillColor(hexColor(0xEC6838))
    ctx.fillPath()
    ctx.setFillColor(hexColor(0xFFD270, alpha: 0.78))
    ctx.fillEllipse(in: CGRect(x: x - 3.5 * s, y: y - 2 * s, width: 7 * s, height: 8 * s))
    ctx.addPath(body)
    ctx.setStrokeColor(hexColor(0x522D1B))
    ctx.setLineWidth(1.5 * s)
    ctx.strokePath()
}

func drawBambooBladeCluster(_ ctx: CGContext, ss: Double, x: Double, y: Double, dir: Double, scale: Double) {
    let s = ss * scale
    for (ang, len, wid, shade) in [(0.35, 22.0, 5.5, 0x7A9B5F as UInt32), (-0.18, 26.0, 6.0, 0x8AA96B as UInt32), (-0.65, 19.0, 5.0, 0x678550 as UInt32)] {
        let a = ang * dir + (dir < 0 ? Double.pi : 0.0)
        let tipX = x + cos(a) * len * s
        let tipY = y + sin(a) * len * s - 4.0 * s
        let ctrlX = x + cos(a) * len * 0.55 * s
        let ctrlY = y + sin(a) * len * 0.55 * s + wid * s
        let p = CGMutablePath()
        p.move(to: CGPoint(x: x, y: y))
        p.addQuadCurve(to: CGPoint(x: tipX, y: tipY), control: CGPoint(x: ctrlX, y: ctrlY))
        p.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: ctrlX, y: ctrlY - wid * 1.45 * s))
        p.closeSubpath()
        ctx.addPath(p)
        ctx.setFillColor(hexColor(shade, alpha: 0.94))
        ctx.fillPath()
        ctx.addPath(p)
        ctx.setStrokeColor(hexColor(0x475E36, alpha: 0.65))
        ctx.setLineWidth(1.1 * s)
        ctx.strokePath()
    }
}

func drawPapertrailsDmgBackground(dest: String, dmgW: Int, dmgH: Int, dpi: Int) {
    let ss = 2.0
    let ow = Int(Double(dmgW) * ss)
    let oh = Int(Double(dmgH) * ss)
    let canvas = makeContext(width: ow, height: oh)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!

    // 1. Warm cotton-rag archival paper base gradient
    let bgGrad = CGGradient(
        colorsSpace: cs,
        colors: [hexColor(0xF7F1E2), hexColor(0xEFE4CE), hexColor(0xE8DAC0)] as CFArray,
        locations: [0.0, 0.56, 1.0]
    )!
    canvas.drawLinearGradient(bgGrad, start: CGPoint(x: 0, y: Double(oh)), end: CGPoint(x: 0, y: 0), options: [])

    // Subtle procedural cold-press cotton-paper fibre speckles
    var seed: UInt64 = 0x5041_5045_5254_5241
    func nextRand() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double((seed >> 33) & 0xFFFF) / 65535.0
    }
    for _ in 0..<2400 {
        let px = nextRand() * Double(ow)
        let py = nextRand() * Double(oh)
        let len = (2.0 + nextRand() * 6.0) * ss
        let light = nextRand() > 0.45
        canvas.setFillColor(light ? hexColor(0xFFFDF8, alpha: 0.16) : hexColor(0x8C7354, alpha: 0.055))
        canvas.fill(CGRect(x: px, y: py, width: len, height: 1.1 * ss))
    }

    // 2. Soft layered cardstock clouds in upper left/right sky
    drawPaperCloud(canvas, w: ow, h: oh, cx: 195.0 * ss, cy: Double(oh) - 125.0 * ss, scale: 1.05 * ss)
    drawPaperCloud(canvas, w: ow, h: oh, cx: 1155.0 * ss, cy: Double(oh) - 148.0 * ss, scale: 0.92 * ss)

    // 3. Lower Jiangnan pop-up paper landscape strip (below yTop=598 -> yCG <= 282*ss)
    // Back sage hill silhouettes
    let backHill = CGMutablePath()
    backHill.move(to: CGPoint(x: -20 * ss, y: 0))
    backHill.addLine(to: CGPoint(x: -20 * ss, y: 245 * ss))
    backHill.addCurve(to: CGPoint(x: 560 * ss, y: 215 * ss), control1: CGPoint(x: 190 * ss, y: 295 * ss), control2: CGPoint(x: 360 * ss, y: 240 * ss))
    backHill.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 255 * ss), control1: CGPoint(x: 820 * ss, y: 185 * ss), control2: CGPoint(x: 1100 * ss, y: 300 * ss))
    backHill.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 0))
    backHill.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: backHill, fill: hexColor(0xD3DEC6), highlight: hexColor(0xEDF3E3, alpha: 0.8), outline: hexColor(0x8A997B, alpha: 0.45), lineWidth: 1.8 * ss, shadowBlur: 8 * ss, shadowAlpha: 0.10)

    let midHill = CGMutablePath()
    midHill.move(to: CGPoint(x: -20 * ss, y: 0))
    midHill.addLine(to: CGPoint(x: -20 * ss, y: 195 * ss))
    midHill.addCurve(to: CGPoint(x: 680 * ss, y: 182 * ss), control1: CGPoint(x: 240 * ss, y: 230 * ss), control2: CGPoint(x: 470 * ss, y: 195 * ss))
    midHill.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 205 * ss), control1: CGPoint(x: 920 * ss, y: 168 * ss), control2: CGPoint(x: 1120 * ss, y: 235 * ss))
    midHill.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 0))
    midHill.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: midHill, fill: hexColor(0xB8C79B), highlight: hexColor(0xDCE5C8, alpha: 0.78), outline: hexColor(0x73855E, alpha: 0.50), lineWidth: 2.0 * ss, shadowBlur: 8 * ss, shadowAlpha: 0.14)

    // Left & right Jiangnan courtyard pavilions rising behind foliage (clear of mount cards)
    drawJiangnanPavilion(canvas, ow: ow, oh: oh, ss: ss, cx: 122.0 * ss, baseY: 168.0 * ss, scale: 0.96, facingRight: true)
    drawJiangnanPavilion(canvas, ow: ow, oh: oh, ss: ss, cx: 1236.0 * ss, baseY: 172.0 * ss, scale: 1.02, facingRight: false)

    // Cut-paper bamboo & leaf sprays cleanly placed along side pavilions (clear of mount card registration ticks)
    for (bx, baseBy, height, dir) in [(28.0, 152.0, 118.0, 1.0), (48.0, 150.0, 102.0, -1.0), (206.0, 154.0, 92.0, 1.0), (1154.0, 154.0, 96.0, -1.0), (1326.0, 152.0, 122.0, -1.0)] {
        let stalk = CGPath(roundedRect: CGRect(x: bx * ss, y: baseBy * ss, width: 4.5 * ss, height: height * ss), cornerWidth: 2 * ss, cornerHeight: 2 * ss, transform: nil)
        canvas.addPath(stalk)
        canvas.setFillColor(hexColor(0x63834B))
        canvas.fillPath()
        canvas.setFillColor(hexColor(0x486235, alpha: 0.65))
        for joint in [0.32, 0.62, 0.88] {
            canvas.fill(CGRect(x: (bx - 0.8) * ss, y: (baseBy + height * joint) * ss, width: 6.1 * ss, height: 1.8 * ss))
        }
        drawBambooBladeCluster(canvas, ss: ss, x: (bx + 2.2) * ss, y: (baseBy + height * 0.62) * ss, dir: -dir, scale: 0.86)
        drawBambooBladeCluster(canvas, ss: ss, x: (bx + 2.2) * ss, y: (baseBy + height * 0.94) * ss, dir: dir, scale: 1.0)
    }

    // Winding 3-step cut-paper Jiangnan canal sweeping across lower panorama
    let canalOuter = CGMutablePath()
    canalOuter.move(to: CGPoint(x: -20 * ss, y: 92 * ss))
    canalOuter.addCurve(to: CGPoint(x: 680 * ss, y: 128 * ss), control1: CGPoint(x: 220 * ss, y: 48 * ss), control2: CGPoint(x: 450 * ss, y: 145 * ss))
    canalOuter.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 102 * ss), control1: CGPoint(x: 910 * ss, y: 112 * ss), control2: CGPoint(x: 1140 * ss, y: 55 * ss))
    canalOuter.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 20 * ss))
    canalOuter.addCurve(to: CGPoint(x: 680 * ss, y: 46 * ss), control1: CGPoint(x: 1120 * ss, y: -15 * ss), control2: CGPoint(x: 900 * ss, y: 38 * ss))
    canalOuter.addCurve(to: CGPoint(x: -20 * ss, y: 18 * ss), control1: CGPoint(x: 460 * ss, y: 54 * ss), control2: CGPoint(x: 210 * ss, y: -22 * ss))
    canalOuter.closeSubpath()
    // Bluestone quay lip around canal
    drawPaperShape(canvas, w: ow, h: oh, path: canalOuter, fill: hexColor(0x88BEC4), highlight: hexColor(0xBCE3E6, alpha: 0.85), outline: hexColor(0xCBC3B0), lineWidth: 9.0 * ss, shadowBlur: 6 * ss, shadowAlpha: 0.16)

    // Mid-depth & deep cut-paper canal terraces
    let canalMid = CGMutablePath()
    canalMid.move(to: CGPoint(x: -20 * ss, y: 74 * ss))
    canalMid.addCurve(to: CGPoint(x: 680 * ss, y: 108 * ss), control1: CGPoint(x: 220 * ss, y: 34 * ss), control2: CGPoint(x: 450 * ss, y: 124 * ss))
    canalMid.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 84 * ss), control1: CGPoint(x: 910 * ss, y: 94 * ss), control2: CGPoint(x: 1140 * ss, y: 40 * ss))
    canalMid.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 32 * ss))
    canalMid.addCurve(to: CGPoint(x: 680 * ss, y: 58 * ss), control1: CGPoint(x: 1120 * ss, y: 4 * ss), control2: CGPoint(x: 900 * ss, y: 52 * ss))
    canalMid.addCurve(to: CGPoint(x: -20 * ss, y: 32 * ss), control1: CGPoint(x: 460 * ss, y: 66 * ss), control2: CGPoint(x: 210 * ss, y: 0))
    canalMid.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: canalMid, fill: hexColor(0x5E9FA8), highlight: hexColor(0x98CED4, alpha: 0.8), outline: hexColor(0x3B7078, alpha: 0.4), lineWidth: 2.0 * ss, shadowBlur: 4 * ss, shadowAlpha: 0.15)

    let canalDeep = CGMutablePath()
    canalDeep.move(to: CGPoint(x: -20 * ss, y: 61 * ss))
    canalDeep.addCurve(to: CGPoint(x: 680 * ss, y: 94 * ss), control1: CGPoint(x: 220 * ss, y: 23 * ss), control2: CGPoint(x: 450 * ss, y: 110 * ss))
    canalDeep.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 70 * ss), control1: CGPoint(x: 910 * ss, y: 80 * ss), control2: CGPoint(x: 1140 * ss, y: 27 * ss))
    canalDeep.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 44 * ss))
    canalDeep.addCurve(to: CGPoint(x: 680 * ss, y: 70 * ss), control1: CGPoint(x: 1120 * ss, y: 16 * ss), control2: CGPoint(x: 900 * ss, y: 64 * ss))
    canalDeep.addCurve(to: CGPoint(x: -20 * ss, y: 44 * ss), control1: CGPoint(x: 460 * ss, y: 78 * ss), control2: CGPoint(x: 210 * ss, y: 12 * ss))
    canalDeep.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: canalDeep, fill: hexColor(0x417F8A), highlight: hexColor(0x7ABAC2, alpha: 0.55), outline: hexColor(0x2B5861, alpha: 0.35), lineWidth: 1.4 * ss, shadowBlur: 3 * ss, shadowAlpha: 0.12)

    // Center miniature carved stone arch bridge anchored smoothly onto left & right quays under x=680
    let bx = 680.0 * ss
    let bridge = CGMutablePath()
    bridge.move(to: CGPoint(x: bx - 120 * ss, y: 122 * ss))
    bridge.addQuadCurve(to: CGPoint(x: bx + 120 * ss, y: 122 * ss), control: CGPoint(x: bx, y: 174 * ss))
    bridge.addLine(to: CGPoint(x: bx + 114 * ss, y: 86 * ss))
    bridge.addLine(to: CGPoint(x: bx + 54 * ss, y: 86 * ss))
    bridge.addQuadCurve(to: CGPoint(x: bx - 54 * ss, y: 86 * ss), control: CGPoint(x: bx, y: 138 * ss))
    bridge.addLine(to: CGPoint(x: bx - 114 * ss, y: 86 * ss))
    bridge.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: bridge, fill: hexColor(0xEAE2CE), highlight: hexColor(0xFAF5EA, alpha: 0.88), outline: hexColor(0x6D5A45, alpha: 0.78), lineWidth: 2.2 * ss, shadowOffset: CGSize(width: 2 * ss, height: -5 * ss), shadowBlur: 6 * ss, shadowAlpha: 0.24)
    // Parapet top coping arc & stone posts
    let coping = CGMutablePath()
    coping.move(to: CGPoint(x: bx - 116 * ss, y: 122 * ss))
    coping.addQuadCurve(to: CGPoint(x: bx + 116 * ss, y: 122 * ss), control: CGPoint(x: bx, y: 170 * ss))
    canvas.addPath(coping)
    canvas.setStrokeColor(hexColor(0x9E8E76, alpha: 0.58))
    canvas.setLineWidth(1.8 * ss)
    canvas.strokePath()
    drawPaperLantern(canvas, ow: ow, oh: oh, ss: ss, x: bx - 68 * ss, postBottomY: 130 * ss, y: 158 * ss, scale: 0.90)
    drawPaperLantern(canvas, ow: ow, oh: oh, ss: ss, x: bx + 68 * ss, postBottomY: 130 * ss, y: 158 * ss, scale: 0.90)

    // Tiny wooden awning boat moored on right canal stretch + soft water wake lines
    let boatX = 955.0 * ss
    let boatY = 74.0 * ss
    canvas.setStrokeColor(hexColor(0xCFEBED, alpha: 0.58))
    canvas.setLineWidth(1.6 * ss)
    canvas.setLineCap(.round)
    for (ox, oy, wWake) in [(-56.0, -5.0, 26.0), (-44.0, -11.0, 18.0), (50.0, -4.0, 22.0)] {
        canvas.beginPath()
        canvas.move(to: CGPoint(x: boatX + ox * ss, y: boatY + oy * ss))
        canvas.addLine(to: CGPoint(x: boatX + (ox + wWake) * ss, y: boatY + oy * ss))
        canvas.strokePath()
    }
    let hull = CGMutablePath()
    hull.move(to: CGPoint(x: boatX - 42 * ss, y: boatY))
    hull.addQuadCurve(to: CGPoint(x: boatX + 42 * ss, y: boatY), control: CGPoint(x: boatX, y: boatY - 22 * ss))
    hull.addLine(to: CGPoint(x: boatX + 30 * ss, y: boatY + 8 * ss))
    hull.addLine(to: CGPoint(x: boatX - 30 * ss, y: boatY + 8 * ss))
    hull.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: hull, fill: hexColor(0x6D4529), outline: hexColor(0x3D2514), lineWidth: 1.8 * ss, shadowBlur: 4 * ss, shadowAlpha: 0.22)
    let awning = CGPath(roundedRect: CGRect(x: boatX - 18 * ss, y: boatY + 2 * ss, width: 34 * ss, height: 18 * ss), cornerWidth: 9 * ss, cornerHeight: 9 * ss, transform: nil)
    drawPaperShape(canvas, w: ow, h: oh, path: awning, fill: hexColor(0x343B44), highlight: hexColor(0x5E6873, alpha: 0.65), outline: hexColor(0x23272D), lineWidth: 1.6 * ss, shadowBlur: 3 * ss, shadowAlpha: 0.18)

    // Foreground grassy riverbanks + stepping stones
    let fgBank = CGMutablePath()
    fgBank.move(to: CGPoint(x: -20 * ss, y: 0))
    fgBank.addLine(to: CGPoint(x: -20 * ss, y: 38 * ss))
    fgBank.addCurve(to: CGPoint(x: 420 * ss, y: 18 * ss), control1: CGPoint(x: 130 * ss, y: 44 * ss), control2: CGPoint(x: 270 * ss, y: 6 * ss))
    fgBank.addCurve(to: CGPoint(x: Double(ow) + 20 * ss, y: 36 * ss), control1: CGPoint(x: 740 * ss, y: 34 * ss), control2: CGPoint(x: 1090 * ss, y: 6 * ss))
    fgBank.addLine(to: CGPoint(x: Double(ow) + 20 * ss, y: 0))
    fgBank.closeSubpath()
    drawPaperShape(canvas, w: ow, h: oh, path: fgBank, fill: hexColor(0x88A46C), highlight: hexColor(0xAFC694, alpha: 0.78), outline: hexColor(0x576D43, alpha: 0.65), lineWidth: 2.0 * ss, shadowBlur: 5 * ss, shadowAlpha: 0.14)

    // 4. Die-cut recessed mount slots at exact Finder icon positions (360, 420) & (1000, 420)
    drawPaperMountSlot(canvas, ow: ow, oh: oh, ss: ss, cx: 360.0, cyTop: 420.0)
    drawPaperMountSlot(canvas, ow: ow, oh: oh, ss: ss, cx: 1000.0, cyTop: 420.0)

    // 5. Papertrails dashed stitch path + center folded cardstock arrow tab at (680, 420)
    let acx = 680.0 * ss
    let acyCg = Double(oh) - 420.0 * ss
    canvas.saveGState()
    canvas.setStrokeColor(hexColor(0x8B7050, alpha: 0.45))
    canvas.setLineWidth(2.6 * ss)
    canvas.setLineDash(phase: 0, lengths: [7.0 * ss, 7.0 * ss])
    canvas.setLineCap(.round)
    canvas.beginPath()
    canvas.move(to: CGPoint(x: 544.0 * ss, y: acyCg))
    canvas.addLine(to: CGPoint(x: 816.0 * ss, y: acyCg))
    canvas.strokePath()
    canvas.restoreGState()

    let pillW = 122.0 * ss
    let pillH = 74.0 * ss
    let arrowRect = CGRect(x: acx - pillW / 2.0, y: acyCg - pillH / 2.0, width: pillW, height: pillH)
    let arrowPath = CGPath(roundedRect: arrowRect, cornerWidth: pillH / 2.0, cornerHeight: pillH / 2.0, transform: nil)
    drawPaperShape(
        canvas,
        w: ow,
        h: oh,
        path: arrowPath,
        fill: hexColor(0xFBF7EC, alpha: 0.96),
        highlight: hexColor(0xFFFFFF, alpha: 0.92),
        outline: hexColor(0x7C6345, alpha: 0.52),
        lineWidth: 2.2 * ss,
        shadowOffset: CGSize(width: 0.0, height: -5.0 * ss),
        shadowBlur: 10.0 * ss,
        shadowAlpha: 0.18
    )

    // Warm vermilion seal dot accent on left of arrow + crisp sepia arrow stroke
    canvas.setFillColor(hexColor(0xC95B3C, alpha: 0.88))
    canvas.fillEllipse(in: CGRect(x: acx - 32.0 * ss, y: acyCg - 4.0 * ss, width: 8.0 * ss, height: 8.0 * ss))
    let ink = hexColor(0x5E4227, alpha: 0.94)
    let stroke = 6.5 * ss
    drawCapsule(canvas, from: CGPoint(x: acx - 16.0 * ss, y: acyCg), to: CGPoint(x: acx + 24.0 * ss, y: acyCg), width: stroke, color: ink)
    drawCapsule(canvas, from: CGPoint(x: acx + 10.0 * ss, y: acyCg + 15.0 * ss), to: CGPoint(x: acx + 26.0 * ss, y: acyCg), width: stroke, color: ink)
    drawCapsule(canvas, from: CGPoint(x: acx + 10.0 * ss, y: acyCg - 15.0 * ss), to: CGPoint(x: acx + 26.0 * ss, y: acyCg), width: stroke, color: ink)

    let out1x = resize(canvas.makeImage()!, width: dmgW, height: dmgH)
    writePng(out1x, to: dest, dpi: dpi, opaqueRgb: true)
}

let planData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let plan = try JSONDecoder().decode(RenderPlan.self, from: planData)
if plan.dmgOnly != true, let rawIconPath = plan.rawIcon {
    let baseIcon = resize(loadImage(rawIconPath), width: plan.iconSize, height: plan.iconSize)
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
}

drawPapertrailsDmgBackground(dest: plan.dmgOut, dmgW: plan.dmgW, dmgH: plan.dmgH, dpi: plan.dmgDpi)
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

function buildFavicons(fallbackPng: string, iconsDir: string): void {
  mkdirSync(iconsDir, { recursive: true });
  for (const dim of FAVICON_SIZES) {
    const dest = join(iconsDir, `app-${dim}.png`);
    execFileSync("sips", ["-z", String(dim), String(dim), fallbackPng, "--out", dest], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    console.log(`Generated ${relative(ROOT, dest)} (${dim}x${dim})`);
  }
}

export function generateMacBranding(rawDir = DEFAULT_RAW_DIR, outDir = DEFAULT_OUT_DIR, dmgOnly = false, iconsOutDir?: string): number {
  const rawIcon = join(rawDir, "app-icon.png");
  if (!dmgOnly && !existsSync(rawIcon)) {
    console.error(`Missing raw asset: ${rawIcon}. Run vibevalley-assets/scripts/pack_all.sh or ./design/sync-assets.sh --build first.`);
    return 1;
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
        rawIcon: dmgOnly ? null : rawIcon,
        rawBg: null,
        dmgOnly,
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

    if (!dmgOnly) {
      for (const spec of CHANNELS) {
        const pngPath = join(outDir, `appicon-${spec.channel}.png`);
        const fallbackPng = join(work, `fallback-${spec.channel}.png`);
        const icnsPath = join(outDir, spec.icnsName);
        buildIcns(fallbackPng, icnsPath);
        console.log(`Generated ${relative(ROOT, pngPath)} and ${relative(ROOT, icnsPath)}`);
      }
      if (iconsOutDir) {
        buildFavicons(join(work, "fallback-release.png"), iconsOutDir);
      }
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
      "icons-dir": { type: "string" },
      "dmg-only": { type: "boolean", default: false },
    },
  });
  const outDir = values["out-dir"] ?? DEFAULT_OUT_DIR;
  process.exitCode = generateMacBranding(values["raw-dir"] ?? DEFAULT_RAW_DIR, outDir, values["dmg-only"], values["icons-dir"]);
}
