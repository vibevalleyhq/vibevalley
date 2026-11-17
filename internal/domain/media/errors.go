package media

import "errors"

var (
	ErrAssetNotFound    = errors.New("media: asset not found")
	ErrInvalidSHA256    = errors.New("media: invalid sha256 digest")
	ErrCorruptedAsset   = errors.New("media: stored asset sha256 verification failed")
	ErrChecksumMismatch = errors.New("media: harvested output sha256 mismatch")
	ErrSizeMismatch     = errors.New("media: harvested output size mismatch")
	ErrMissingData      = errors.New("media: harvested output data missing")
	ErrInvalidRelPath   = errors.New("media: invalid output relative path")
	ErrAssetTooLarge    = errors.New("media: asset exceeds maximum allowed size")
	ErrInvalidDisplay   = errors.New("media: invalid artifact display mode")
)
