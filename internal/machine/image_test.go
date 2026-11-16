package machine

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func buildEXIFTIFF(order binary.ByteOrder, orientation uint16) []byte {
	var buf bytes.Buffer
	if order == binary.LittleEndian {
		buf.WriteString("II")
	} else {
		buf.WriteString("MM")
	}
	_ = binary.Write(&buf, order, uint16(0x002A))
	_ = binary.Write(&buf, order, uint32(8))
	_ = binary.Write(&buf, order, uint16(1))
	_ = binary.Write(&buf, order, uint16(0x0112)) // Orientation tag
	_ = binary.Write(&buf, order, uint16(3))      // SHORT
	_ = binary.Write(&buf, order, uint32(1))      // count
	_ = binary.Write(&buf, order, orientation)
	_ = binary.Write(&buf, order, uint16(0)) // padding to 4-byte valueOffset
	return buf.Bytes()
}

func injectJPEGAPP1(jpegBytes, app1Payload []byte) []byte {
	if len(jpegBytes) < 2 {
		return jpegBytes
	}
	var out bytes.Buffer
	out.Write(jpegBytes[:2]) // SOI
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(app1Payload)+2))
	out.Write(app1Payload)
	out.Write(jpegBytes[2:])
	return out.Bytes()
}

func injectPNGEXIfChunk(pngBytes, tiff []byte) []byte {
	const sigLen = 8
	if len(pngBytes) < sigLen+12 {
		return pngBytes
	}
	ihdrLen := int(binary.BigEndian.Uint32(pngBytes[sigLen : sigLen+4]))
	insertAt := sigLen + 12 + ihdrLen

	var out bytes.Buffer
	out.Write(pngBytes[:insertAt])

	_ = binary.Write(&out, binary.BigEndian, uint32(len(tiff)))
	chunkStart := out.Len()
	out.WriteString("eXIf")
	out.Write(tiff)
	crc := crc32.ChecksumIEEE(out.Bytes()[chunkStart:])
	_ = binary.Write(&out, binary.BigEndian, crc)

	out.Write(pngBytes[insertAt:])
	return out.Bytes()
}

// buildUprightPattern creates a 40x20 image with four solid colored quadrants:
// top-left=Red, top-right=Green, bottom-left=Blue, bottom-right=Yellow.
func buildUprightPattern() *image.NRGBA {
	const w, h = 40, 20
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	tl := color.NRGBA{R: 240, G: 20, B: 20, A: 255}
	tr := color.NRGBA{R: 20, G: 240, B: 20, A: 255}
	bl := color.NRGBA{R: 20, G: 20, B: 240, A: 255}
	br := color.NRGBA{R: 240, G: 240, B: 20, A: 255}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			switch {
			case x < w/2 && y < h/2:
				img.SetNRGBA(x, y, tl)
			case x >= w/2 && y < h/2:
				img.SetNRGBA(x, y, tr)
			case x < w/2 && y >= h/2:
				img.SetNRGBA(x, y, bl)
			default:
				img.SetNRGBA(x, y, br)
			}
		}
	}
	return img
}

// inverseOrientation encodes an upright image into stored pixel space before the given EXIF tag is applied.
func inverseOrientation(upright *image.NRGBA, orientation int) *image.NRGBA {
	invMap := map[int]int{
		1: 1,
		2: 2,
		3: 3,
		4: 4,
		5: 5,
		6: 8,
		7: 7,
		8: 6,
	}
	return applyEXIFOrientation(upright, invMap[orientation])
}

func assertQuadrantColors(t *testing.T, img image.Image) {
	t.Helper()
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w != 40 || h != 20 {
		t.Fatalf("expected upright 40x20, got %dx%d", w, h)
	}
	checkSample := func(name string, x, y int, wantR, wantG, wantB uint8) {
		r, g, bl, _ := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
		gotR, gotG, gotB := uint8(r>>8), uint8(g>>8), uint8(bl>>8)
		diff := absDiff(gotR, wantR) + absDiff(gotG, wantG) + absDiff(gotB, wantB)
		if diff > 45 {
			t.Errorf("%s (%d,%d): got RGB(%d,%d,%d), want near (%d,%d,%d)", name, x, y, gotR, gotG, gotB, wantR, wantG, wantB)
		}
	}
	checkSample("TL-red", 8, 4, 240, 20, 20)
	checkSample("TR-green", 32, 4, 20, 240, 20)
	checkSample("BL-blue", 8, 16, 20, 20, 240)
	checkSample("BR-yellow", 32, 16, 240, 240, 20)
}

func absDiff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

func TestNormalizeImageEXIFAllOrientationsLittleAndBigEndian(t *testing.T) {
	t.Parallel()
	upright := buildUprightPattern()
	orders := []struct {
		name  string
		order binary.ByteOrder
	}{
		{"little-endian", binary.LittleEndian},
		{"big-endian", binary.BigEndian},
	}

	for _, ord := range orders {
		for orient := 1; orient <= 8; orient++ {
			stored := inverseOrientation(upright, orient)
			var rawJPEG bytes.Buffer
			if err := jpeg.Encode(&rawJPEG, stored, &jpeg.Options{Quality: 95}); err != nil {
				t.Fatalf("jpeg.Encode: %v", err)
			}
			app1 := append([]byte("Exif\x00\x00"), buildEXIFTIFF(ord.order, uint16(orient))...)
			withEXIF := injectJPEGAPP1(rawJPEG.Bytes(), app1)

			// Ensure XMP APP1 ahead of EXIF APP1 doesn't break orientation parsing.
			withXMPAndEXIF := injectJPEGAPP1(withEXIF, []byte("http://ns.adobe.com/xap/1.0/\x00<xmp/>"))

			gotOrient := ParseEXIFOrientation(withXMPAndEXIF, "jpeg")
			if gotOrient != orient {
				t.Fatalf("%s orient=%d: ParseEXIFOrientation=%d", ord.name, orient, gotOrient)
			}

			norm, err := NormalizeImage(withXMPAndEXIF, contract.ImageBounds{
				MaxWidth:  contract.DefaultMaxImageWidth,
				MaxHeight: contract.DefaultMaxImageHeight,
				MaxBytes:  contract.DefaultMaxImageBytes,
			})
			if err != nil {
				t.Fatalf("%s orient=%d NormalizeImage: %v", ord.name, orient, err)
			}
			if norm.Orientation != orient {
				t.Fatalf("expected reported orientation %d, got %d", orient, norm.Orientation)
			}
			if orient > 1 && !norm.Modified {
				t.Fatalf("orient=%d expected Modified=true", orient)
			}
			if gotAfter := ParseEXIFOrientation(norm.Data, "jpeg"); gotAfter != 1 {
				t.Fatalf("normalized image still carries orientation=%d", gotAfter)
			}
			decoded, _, err := image.Decode(bytes.NewReader(norm.Data))
			if err != nil {
				t.Fatalf("decode normalized: %v", err)
			}
			assertQuadrantColors(t, decoded)
		}
	}

	// PNG eXIf chunk rotation check.
	storedPNG := inverseOrientation(upright, 6)
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, storedPNG); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	pngWithEXIF := injectPNGEXIfChunk(pngBuf.Bytes(), buildEXIFTIFF(binary.BigEndian, 6))
	normPNG, err := NormalizeImage(pngWithEXIF, contract.ImageBounds{})
	if err != nil {
		t.Fatalf("NormalizeImage PNG: %v", err)
	}
	decodedPNG, _, err := image.Decode(bytes.NewReader(normPNG.Data))
	if err != nil {
		t.Fatalf("decode normalized PNG: %v", err)
	}
	assertQuadrantColors(t, decodedPNG)
}

func TestNormalizeImageProportionalScalingAndByteLimit(t *testing.T) {
	t.Parallel()

	// Stored 1600x3200 with EXIF orientation 6 (rotates to 3200x1600), then scales proportionally to 2000x1000.
	img := image.NewNRGBA(image.Rect(0, 0, 1600, 3200))
	for y := 0; y < 3200; y += 8 {
		for x := 0; x < 1600; x += 8 {
			c := color.NRGBA{R: uint8(x % 256), G: uint8(y % 256), B: 180, A: 255}
			img.SetNRGBA(x, y, c)
		}
	}
	var jpgBuf bytes.Buffer
	if err := jpeg.Encode(&jpgBuf, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	withEXIF := injectJPEGAPP1(jpgBuf.Bytes(), append([]byte("Exif\x00\x00"), buildEXIFTIFF(binary.LittleEndian, 6)...))

	norm, err := NormalizeImage(withEXIF, contract.ImageBounds{
		MaxWidth:  contract.DefaultMaxImageWidth,
		MaxHeight: contract.DefaultMaxImageHeight,
		MaxBytes:  contract.DefaultMaxImageBytes,
	})
	if err != nil {
		t.Fatalf("NormalizeImage large rotated JPEG: %v", err)
	}
	if norm.Width != 2000 || norm.Height != 1000 {
		t.Fatalf("expected 2000x1000 proportional scaling after rotation, got %dx%d", norm.Width, norm.Height)
	}
	if int64(len(norm.Data)) > contract.DefaultMaxImageBytes {
		t.Fatalf("normalized bytes %d exceed 4.5 MiB (%d)", len(norm.Data), contract.DefaultMaxImageBytes)
	}

	// Byte-budget tightening test: force tight MaxBytes on a noisy PNG.
	noisy := image.NewNRGBA(image.Rect(0, 0, 900, 600))
	var state uint32 = 0x12345678
	for y := 0; y < 600; y++ {
		for x := 0; x < 900; x++ {
			state = state*1664525 + 1013904223
			noisy.SetNRGBA(x, y, color.NRGBA{
				R: uint8(state >> 24),
				G: uint8(state >> 16),
				B: uint8(state >> 8),
				A: 255,
			})
		}
	}
	var noisyPNG bytes.Buffer
	if err := png.Encode(&noisyPNG, noisy); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	const tightMaxBytes = 40_000
	if noisyPNG.Len() <= tightMaxBytes {
		t.Fatalf("expected noisy PNG > %d bytes, got %d", tightMaxBytes, noisyPNG.Len())
	}

	shrunk, err := NormalizeImage(noisyPNG.Bytes(), contract.ImageBounds{
		MaxWidth:  2000,
		MaxHeight: 2000,
		MaxBytes:  tightMaxBytes,
	})
	if err != nil {
		t.Fatalf("NormalizeImage byte cap: %v", err)
	}
	if int64(len(shrunk.Data)) > tightMaxBytes {
		t.Fatalf("expected shrunk size <= %d, got %d", tightMaxBytes, len(shrunk.Data))
	}
	if shrunk.Width <= 0 || shrunk.Height <= 0 {
		t.Fatalf("invalid shrunk dimensions %dx%d", shrunk.Width, shrunk.Height)
	}

	// Fast-path passthrough & animated GIF scaling.
	pal := color.Palette{color.Black, color.White, color.RGBA{R: 255, A: 255}}
	anim := &gif.GIF{
		Image: []*image.Paletted{
			image.NewPaletted(image.Rect(0, 0, 120, 60), pal),
			image.NewPaletted(image.Rect(0, 0, 120, 60), pal),
		},
		Delay:  []int{10, 10},
		Config: image.Config{ColorModel: pal, Width: 120, Height: 60},
	}
	var gifBuf bytes.Buffer
	if err := gif.EncodeAll(&gifBuf, anim); err != nil {
		t.Fatalf("gif.EncodeAll: %v", err)
	}
	pass, err := NormalizeImage(gifBuf.Bytes(), contract.ImageBounds{})
	if err != nil {
		t.Fatalf("NormalizeImage GIF passthrough: %v", err)
	}
	if pass.Modified || !bytes.Equal(pass.Data, gifBuf.Bytes()) {
		t.Fatal("expected small upright GIF to pass through unmodified")
	}

	scaledGIF, err := NormalizeImage(gifBuf.Bytes(), contract.ImageBounds{MaxWidth: 60, MaxHeight: 60, MaxBytes: 1 << 20})
	if err != nil {
		t.Fatalf("NormalizeImage GIF resize: %v", err)
	}
	if scaledGIF.Width != 60 || scaledGIF.Height != 30 {
		t.Fatalf("expected GIF scaled to 60x30, got %dx%d", scaledGIF.Width, scaledGIF.Height)
	}
	decodedGIF, err := gif.DecodeAll(bytes.NewReader(scaledGIF.Data))
	if err != nil || len(decodedGIF.Image) != 2 {
		t.Fatalf("expected 2 frames preserved in scaled GIF, err=%v frames=%d", err, len(decodedGIF.Image))
	}

	// Truncated EXIF must never panic.
	if got := parseTIFFOrientation([]byte("II*\x00\xff\xff")); got != 1 {
		t.Fatalf("expected truncated TIFF to default to 1, got %d", got)
	}
}
