package machine

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const maxImagePixels int64 = 100_000_000

var (
	ErrImageTooLarge    = errors.New("machine: image exceeds pixel or byte constraints")
	ErrUnsupportedImage = errors.New("machine: unsupported image format")
)

// NormalizedImage holds image bytes transformed to upright orientation and scaled within ImageBounds.
type NormalizedImage struct {
	Data        []byte `json:"data"`
	Format      string `json:"format"`
	MimeType    string `json:"mimeType"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Orientation int    `json:"orientation"`
	Modified    bool   `json:"modified"`
}

// NormalizeImage parses EXIF orientation, applies upright rotation/flip, and proportionally scales
// the image using pure Go stdlib codecs so dimensions and byte size satisfy bounds.
func NormalizeImage(src []byte, bounds contract.ImageBounds) (NormalizedImage, error) {
	if len(src) == 0 {
		return NormalizedImage{}, fmt.Errorf("%w: empty image payload", ErrUnsupportedImage)
	}
	bounds = resolveImageBounds(bounds)

	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil {
		return NormalizedImage{}, fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return NormalizedImage{}, fmt.Errorf("%w: invalid dimensions %dx%d", ErrUnsupportedImage, cfg.Width, cfg.Height)
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxImagePixels {
		return NormalizedImage{}, fmt.Errorf("%w: %dx%d exceeds pixel safety limit", ErrImageTooLarge, cfg.Width, cfg.Height)
	}

	orientation := ParseEXIFOrientation(src, format)
	if orientation == 1 && cfg.Width <= bounds.MaxWidth && cfg.Height <= bounds.MaxHeight && int64(len(src)) <= bounds.MaxBytes {
		return NormalizedImage{
			Data:        src,
			Format:      format,
			MimeType:    mimeForImageFormat(format),
			Width:       cfg.Width,
			Height:      cfg.Height,
			Orientation: orientation,
			Modified:    false,
		}, nil
	}

	if format == "gif" && orientation == 1 {
		if out, w, h, handled, err := normalizeAnimatedGIF(src, bounds); handled {
			if err != nil {
				return NormalizedImage{}, err
			}
			return NormalizedImage{
				Data:        out,
				Format:      "gif",
				MimeType:    "image/gif",
				Width:       w,
				Height:      h,
				Orientation: 1,
				Modified:    true,
			}, nil
		}
	}

	decoded, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return NormalizedImage{}, fmt.Errorf("%w: decode %v", ErrUnsupportedImage, err)
	}

	nrgba := toNRGBA(decoded)
	if orientation != 1 {
		nrgba = applyEXIFOrientation(nrgba, orientation)
	}

	curW := nrgba.Bounds().Dx()
	curH := nrgba.Bounds().Dy()
	targetW, targetH := fitProportional(curW, curH, bounds.MaxWidth, bounds.MaxHeight)
	if targetW != curW || targetH != curH {
		nrgba = resizeNRGBA(nrgba, targetW, targetH)
	}

	out, finalW, finalH, err := encodeWithinBudget(nrgba, format, bounds.MaxBytes)
	if err != nil {
		return NormalizedImage{}, err
	}

	return NormalizedImage{
		Data:        out,
		Format:      format,
		MimeType:    mimeForImageFormat(format),
		Width:       finalW,
		Height:      finalH,
		Orientation: orientation,
		Modified:    true,
	}, nil
}

// ParseEXIFOrientation extracts the TIFF/EXIF orientation tag (1..8) from JPEG APP1 or PNG eXIf chunks.
func ParseEXIFOrientation(data []byte, format string) int {
	switch format {
	case "jpeg":
		return parseJPEGEXIFOrientation(data)
	case "png":
		return parsePNGEXIFOrientation(data)
	default:
		return 1
	}
}

func resolveImageBounds(b contract.ImageBounds) contract.ImageBounds {
	if b.MaxWidth <= 0 {
		b.MaxWidth = contract.DefaultMaxImageWidth
	}
	if b.MaxHeight <= 0 {
		b.MaxHeight = contract.DefaultMaxImageHeight
	}
	if b.MaxBytes <= 0 {
		b.MaxBytes = contract.DefaultMaxImageBytes
	}
	return b
}

func mimeForImageFormat(format string) string {
	switch format {
	case "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	default:
		return "application/octet-stream"
	}
}

func fitProportional(w, h, maxW, maxH int) (int, int) {
	if w <= maxW && h <= maxH {
		return w, h
	}
	scale := min(float64(maxW)/float64(w), float64(maxH)/float64(h))
	newW := max(1, int(math.Round(float64(w)*scale)))
	newH := max(1, int(math.Round(float64(h)*scale)))
	if newW > maxW {
		newW = maxW
	}
	if newH > maxH {
		newH = maxH
	}
	return newW, newH
}

func encodeWithinBudget(img *image.NRGBA, format string, maxBytes int64) ([]byte, int, int, error) {
	cur := img
	for attempt := 0; attempt < 16; attempt++ {
		w := cur.Bounds().Dx()
		h := cur.Bounds().Dy()
		encoded, lastLen, ok, err := encodeFormatWithinBytes(cur, format, maxBytes)
		if err != nil {
			return nil, 0, 0, err
		}
		if ok {
			return encoded, w, h, nil
		}
		if w <= 1 && h <= 1 {
			break
		}
		scale := 0.85
		if lastLen > maxBytes && maxBytes > 0 {
			est := math.Sqrt(float64(maxBytes)/float64(lastLen)) * 0.92
			scale = max(0.35, min(0.85, est))
		}
		nextW := max(1, int(math.Floor(float64(w)*scale)))
		nextH := max(1, int(math.Floor(float64(h)*scale)))
		if nextW == w && w > 1 {
			nextW = w - 1
		}
		if nextH == h && h > 1 {
			nextH = h - 1
		}
		cur = resizeNRGBA(cur, nextW, nextH)
	}
	return nil, 0, 0, fmt.Errorf("%w: cannot compress below %d bytes", ErrImageTooLarge, maxBytes)
}

func encodeFormatWithinBytes(img image.Image, format string, maxBytes int64) ([]byte, int64, bool, error) {
	switch format {
	case "jpeg":
		qualities := []int{88, 80, 72, 62, 50}
		var lastLen int64
		for _, q := range qualities {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
				return nil, 0, false, err
			}
			lastLen = int64(buf.Len())
			if lastLen <= maxBytes {
				return buf.Bytes(), lastLen, true, nil
			}
		}
		return nil, lastLen, false, nil
	case "png":
		var buf bytes.Buffer
		enc := png.Encoder{CompressionLevel: png.BestCompression}
		if err := enc.Encode(&buf, img); err != nil {
			return nil, 0, false, err
		}
		lastLen := int64(buf.Len())
		if lastLen <= maxBytes {
			return buf.Bytes(), lastLen, true, nil
		}
		return nil, lastLen, false, nil
	case "gif":
		var buf bytes.Buffer
		if err := gif.Encode(&buf, img, nil); err != nil {
			return nil, 0, false, err
		}
		lastLen := int64(buf.Len())
		if lastLen <= maxBytes {
			return buf.Bytes(), lastLen, true, nil
		}
		return nil, lastLen, false, nil
	default:
		return nil, 0, false, fmt.Errorf("%w: %s", ErrUnsupportedImage, format)
	}
}

func normalizeAnimatedGIF(src []byte, bounds contract.ImageBounds) ([]byte, int, int, bool, error) {
	g, err := gif.DecodeAll(bytes.NewReader(src))
	if err != nil {
		return nil, 0, 0, true, fmt.Errorf("%w: decode gif: %v", ErrUnsupportedImage, err)
	}
	if len(g.Image) <= 1 {
		return nil, 0, 0, false, nil
	}

	origW, origH := g.Config.Width, g.Config.Height
	if origW <= 0 || origH <= 0 {
		origW = g.Image[0].Bounds().Dx()
		origH = g.Image[0].Bounds().Dy()
	}

	targetW, targetH := fitProportional(origW, origH, bounds.MaxWidth, bounds.MaxHeight)
	for attempt := 0; attempt < 12; attempt++ {
		scaled := &gif.GIF{
			Image:           make([]*image.Paletted, len(g.Image)),
			Delay:           append([]int(nil), g.Delay...),
			LoopCount:       g.LoopCount,
			Disposal:        append([]byte(nil), g.Disposal...),
			BackgroundIndex: g.BackgroundIndex,
			Config: image.Config{
				ColorModel: g.Config.ColorModel,
				Width:      targetW,
				Height:     targetH,
			},
		}
		for i, frame := range g.Image {
			scaled.Image[i] = scalePalettedFrame(frame, origW, origH, targetW, targetH)
		}
		var buf bytes.Buffer
		if err := gif.EncodeAll(&buf, scaled); err != nil {
			return nil, 0, 0, true, err
		}
		if int64(buf.Len()) <= bounds.MaxBytes {
			return buf.Bytes(), targetW, targetH, true, nil
		}
		if targetW <= 1 && targetH <= 1 {
			break
		}
		targetW = max(1, int(math.Floor(float64(targetW)*0.85)))
		targetH = max(1, int(math.Floor(float64(targetH)*0.85)))
	}
	return nil, 0, 0, true, fmt.Errorf("%w: gif exceeds %d bytes", ErrImageTooLarge, bounds.MaxBytes)
}

func scalePalettedFrame(frame *image.Paletted, origW, origH, targetW, targetH int) *image.Paletted {
	fb := frame.Bounds()
	scaleX := float64(targetW) / float64(origW)
	scaleY := float64(targetH) / float64(origH)

	newMinX := int(math.Floor(float64(fb.Min.X) * scaleX))
	newMinY := int(math.Floor(float64(fb.Min.Y) * scaleY))
	newW := max(1, int(math.Round(float64(fb.Dx())*scaleX)))
	newH := max(1, int(math.Round(float64(fb.Dy())*scaleY)))
	if newMinX+newW > targetW {
		newW = max(1, targetW-newMinX)
	}
	if newMinY+newH > targetH {
		newH = max(1, targetH-newMinY)
	}

	nrgba := toNRGBA(frame)
	resized := resizeNRGBA(nrgba, newW, newH)
	dst := image.NewPaletted(image.Rect(newMinX, newMinY, newMinX+newW, newMinY+newH), frame.Palette)
	draw.FloydSteinberg.Draw(dst, dst.Bounds(), resized, resized.Bounds().Min)
	return dst
}

func toNRGBA(src image.Image) *image.NRGBA {
	b := src.Bounds()
	if nrgba, ok := src.(*image.NRGBA); ok && b.Min.X == 0 && b.Min.Y == 0 {
		return nrgba
	}
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
	return dst
}

func applyEXIFOrientation(src *image.NRGBA, orientation int) *image.NRGBA {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()

	dstW, dstH := w, h
	if orientation >= 5 {
		dstW, dstH = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))

	for y := 0; y < dstH; y++ {
		for x := 0; x < dstW; x++ {
			var sx, sy int
			switch orientation {
			case 2:
				sx, sy = w-1-x, y
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sx, sy = x, h-1-y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			default:
				sx, sy = x, y
			}
			srcOff := src.PixOffset(b.Min.X+sx, b.Min.Y+sy)
			dstOff := dst.PixOffset(x, y)
			copy(dst.Pix[dstOff:dstOff+4], src.Pix[srcOff:srcOff+4])
		}
	}
	return dst
}

func resizeNRGBA(src *image.NRGBA, dstW, dstH int) *image.NRGBA {
	srcB := src.Bounds()
	srcW := srcB.Dx()
	srcH := srcB.Dy()
	if srcW == dstW && srcH == dstH {
		return src
	}

	dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))
	if dstW <= srcW && dstH <= srcH {
		boxDownscaleNRGBA(src, dst, srcW, srcH, dstW, dstH)
		return dst
	}
	bilinearResizeNRGBA(src, dst, srcW, srcH, dstW, dstH)
	return dst
}

func boxDownscaleNRGBA(src, dst *image.NRGBA, srcW, srcH, dstW, dstH int) {
	scaleX := float64(srcW) / float64(dstW)
	scaleY := float64(srcH) / float64(dstH)

	for dy := 0; dy < dstH; dy++ {
		sy0 := float64(dy) * scaleY
		sy1 := float64(dy+1) * scaleY
		iy0 := max(0, int(math.Floor(sy0)))
		iy1 := min(srcH-1, int(math.Ceil(sy1))-1)

		for dx := 0; dx < dstW; dx++ {
			sx0 := float64(dx) * scaleX
			sx1 := float64(dx+1) * scaleX
			ix0 := max(0, int(math.Floor(sx0)))
			ix1 := min(srcW-1, int(math.Ceil(sx1))-1)

			var sumR, sumG, sumB, sumA, sumWeight float64
			for sy := iy0; sy <= iy1; sy++ {
				wy := min(sy1, float64(sy+1)) - max(sy0, float64(sy))
				if wy <= 0 {
					continue
				}
				for sx := ix0; sx <= ix1; sx++ {
					wx := min(sx1, float64(sx+1)) - max(sx0, float64(sx))
					if wx <= 0 {
						continue
					}
					w := wx * wy
					off := sy*src.Stride + sx*4
					a := float64(src.Pix[off+3]) / 255.0
					sumR += float64(src.Pix[off+0]) * a * w
					sumG += float64(src.Pix[off+1]) * a * w
					sumB += float64(src.Pix[off+2]) * a * w
					sumA += float64(src.Pix[off+3]) * w
					sumWeight += w
				}
			}

			dstOff := dy*dst.Stride + dx*4
			if sumWeight <= 0 {
				continue
			}
			avgA := sumA / sumWeight
			if avgA > 0 {
				invA := 255.0 / sumA
				dst.Pix[dstOff+0] = clampUint8(sumR * invA)
				dst.Pix[dstOff+1] = clampUint8(sumG * invA)
				dst.Pix[dstOff+2] = clampUint8(sumB * invA)
				dst.Pix[dstOff+3] = clampUint8(avgA)
			}
		}
	}
}

func bilinearResizeNRGBA(src, dst *image.NRGBA, srcW, srcH, dstW, dstH int) {
	for dy := 0; dy < dstH; dy++ {
		gy := (float64(dy)+0.5)*float64(srcH)/float64(dstH) - 0.5
		gy = max(0, min(float64(srcH-1), gy))
		y0 := int(math.Floor(gy))
		y1 := min(srcH-1, y0+1)
		wy := gy - float64(y0)

		for dx := 0; dx < dstW; dx++ {
			gx := (float64(dx)+0.5)*float64(srcW)/float64(dstW) - 0.5
			gx = max(0, min(float64(srcW-1), gx))
			x0 := int(math.Floor(gx))
			x1 := min(srcW-1, x0+1)
			wx := gx - float64(x0)

			c00 := src.NRGBAAt(x0, y0)
			c10 := src.NRGBAAt(x1, y0)
			c01 := src.NRGBAAt(x0, y1)
			c11 := src.NRGBAAt(x1, y1)

			dst.SetNRGBA(dx, dy, bilerpNRGBA(c00, c10, c01, c11, wx, wy))
		}
	}
}

func bilerpNRGBA(c00, c10, c01, c11 color.NRGBA, wx, wy float64) color.NRGBA {
	w00 := (1 - wx) * (1 - wy)
	w10 := wx * (1 - wy)
	w01 := (1 - wx) * wy
	w11 := wx * wy

	a00 := float64(c00.A) / 255.0
	a10 := float64(c10.A) / 255.0
	a01 := float64(c01.A) / 255.0
	a11 := float64(c11.A) / 255.0

	sumA := float64(c00.A)*w00 + float64(c10.A)*w10 + float64(c01.A)*w01 + float64(c11.A)*w11
	if sumA <= 0 {
		return color.NRGBA{}
	}
	r := (float64(c00.R)*a00*w00 + float64(c10.R)*a10*w10 + float64(c01.R)*a01*w01 + float64(c11.R)*a11*w11) * (255.0 / sumA)
	g := (float64(c00.G)*a00*w00 + float64(c10.G)*a10*w10 + float64(c01.G)*a01*w01 + float64(c11.G)*a11*w11) * (255.0 / sumA)
	b := (float64(c00.B)*a00*w00 + float64(c10.B)*a10*w10 + float64(c01.B)*a01*w01 + float64(c11.B)*a11*w11) * (255.0 / sumA)

	return color.NRGBA{
		R: clampUint8(r),
		G: clampUint8(g),
		B: clampUint8(b),
		A: clampUint8(sumA),
	}
}

func clampUint8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 255 {
		return 255
	}
	return uint8(math.Round(v))
}

func parseJPEGEXIFOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	pos := 2
	for pos+1 < len(data) {
		for pos < len(data) && data[pos] != 0xFF {
			pos++
		}
		for pos < len(data) && data[pos] == 0xFF {
			pos++
		}
		if pos >= len(data) {
			break
		}
		marker := data[pos]
		pos++

		// Standalone markers without length bytes.
		if marker == 0x00 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8) {
			continue
		}
		// Start of scan or end of image stops metadata headers.
		if marker == 0xDA || marker == 0xD9 {
			break
		}
		if pos+2 > len(data) {
			break
		}
		segLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
		if segLen < 2 || pos+segLen > len(data) {
			break
		}
		payload := data[pos+2 : pos+segLen]
		if marker == 0xE1 && bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
			if orient := parseTIFFOrientation(payload[6:]); orient != 1 {
				return orient
			}
			return 1
		}
		pos += segLen
	}
	return 1
}

func parsePNGEXIFOrientation(data []byte) int {
	sig := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}
	if len(data) < len(sig) || !bytes.Equal(data[:len(sig)], sig) {
		return 1
	}
	pos := len(sig)
	for pos+12 <= len(data) {
		chunkLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		chunkType := string(data[pos+4 : pos+8])
		dataStart := pos + 8
		if chunkLen < 0 || dataStart+chunkLen+4 > len(data) {
			break
		}
		if chunkType == "eXIf" {
			return parseTIFFOrientation(data[dataStart : dataStart+chunkLen])
		}
		if chunkType == "IEND" {
			break
		}
		pos = dataStart + chunkLen + 4
	}
	return 1
}

func parseTIFFOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	if order.Uint16(tiff[2:4]) != 0x002A {
		return 1
	}
	ifdOffset := order.Uint32(tiff[4:8])
	if uint64(ifdOffset)+2 > uint64(len(tiff)) {
		return 1
	}
	off := int(ifdOffset)
	count := int(order.Uint16(tiff[off : off+2]))
	off += 2
	for i := 0; i < count; i++ {
		entryStart := off + i*12
		if entryStart+12 > len(tiff) {
			break
		}
		tag := order.Uint16(tiff[entryStart : entryStart+2])
		if tag != 0x0112 {
			continue
		}
		fieldType := order.Uint16(tiff[entryStart+2 : entryStart+4])
		valCount := order.Uint32(tiff[entryStart+4 : entryStart+8])
		if fieldType == 3 && valCount >= 1 {
			orient := int(order.Uint16(tiff[entryStart+8 : entryStart+10]))
			if orient >= 1 && orient <= 8 {
				return orient
			}
		}
		return 1
	}
	return 1
}
