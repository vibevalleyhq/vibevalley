package kernel

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// LoadedImage is an input image read for delivery.
type LoadedImage struct {
	Path      string
	MediaType string
	// Base64 of the file's bytes.
	Data string
}

var imageMediaTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

func mediaTypeOf(image oar.InputImage) string {
	if image.MediaType != "" {
		return image.MediaType
	}
	return imageMediaTypes[strings.ToLower(filepath.Ext(image.Path))]
}

func acceptedMediaType(mediaType string) bool {
	for _, known := range imageMediaTypes {
		if known == mediaType {
			return true
		}
	}
	return false
}

// InputImagesRefusal says why an input's images cannot go, or nil when they
// can (shared/input-images.ts): no image input, not png/jpeg/gif/webp
// (unsupported), or unreadable (error). The whole input is refused.
func InputImagesRefusal(images bool, inputImages []oar.InputImage) *oar.ResponseBody {
	if len(inputImages) == 0 {
		return nil
	}
	if !images {
		refused := oar.Rejected(oar.CodeUnsupported, "this runtime takes no image input")
		return &refused
	}
	for _, image := range inputImages {
		mediaType := mediaTypeOf(image)
		if mediaType == "" || !acceptedMediaType(mediaType) {
			refused := oar.Rejected(oar.CodeUnsupported, "not a png, jpeg, gif or webp image: "+image.Path)
			return &refused
		}
		file, err := os.Open(image.Path)
		if err != nil {
			refused := oar.Rejected(oar.CodeError, fmt.Sprintf("cannot read image %s: %s", image.Path, err))
			return &refused
		}
		_ = file.Close()
	}
	return nil
}

// WithInputImages delivers an input with its images read, or refuses it.
func WithInputImages(images bool, inputImages []oar.InputImage, deliver func(loaded []LoadedImage) (oar.ResponseBody, error)) (oar.ResponseBody, error) {
	if refused := InputImagesRefusal(images, inputImages); refused != nil {
		return *refused, nil
	}
	loaded := make([]LoadedImage, 0, len(inputImages))
	for _, image := range inputImages {
		data, err := os.ReadFile(image.Path)
		if err != nil {
			return oar.Rejected(oar.CodeError, fmt.Sprintf("cannot read image %s: %s", image.Path, err)), nil
		}
		loaded = append(loaded, LoadedImage{Path: image.Path, MediaType: mediaTypeOf(image), Data: base64.StdEncoding.EncodeToString(data)})
	}
	return deliver(loaded)
}

// HeldInput is an input an adapter holds for a later turn, found by its inputId.
type HeldInput interface {
	HeldInputID() string
}

// WithdrawHeld removes every entry held for inputID and answers accepted, or
// not_queued when none is waiting (shared/held-input.ts). Call it from the
// withdraw's Control decision while holding the lock the adapter's drain
// takes the entry off under, so a withdraw either removes the entry before
// the drain reaches it or finds it gone.
func WithdrawHeld[T HeldInput](held *[]T, inputID string) oar.ResponseBody {
	before := len(*held)
	kept := (*held)[:0]
	for _, entry := range *held {
		if entry.HeldInputID() != inputID {
			kept = append(kept, entry)
		}
	}
	var zero T
	for i := len(kept); i < before; i++ {
		(*held)[i] = zero
	}
	*held = kept
	if len(kept) < before {
		return oar.Accepted()
	}
	return oar.Rejected(oar.CodeNotQueued, "no held input with this inputId is waiting")
}
