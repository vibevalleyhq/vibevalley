package base

import (
	"fmt"
	"os"
	"path/filepath"
)

func leaseHome(home string) (*os.File, error) {
	path, err := filepath.Abs(home)
	if err != nil {
		return nil, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	// Never unlink this file: a new inode would let another process bypass the held lease.
	file, err := os.OpenFile(filepath.Join(path, ".vibevalley.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	locked, err := lockHomeFile(file)
	if err != nil || !locked {
		file.Close()
		if err != nil {
			return nil, fmt.Errorf("锁不住农场目录 %s：%w", path, err)
		}
		return nil, fmt.Errorf("农场目录 %s 正被另一个服务端使用；请连接现有农场，或先停掉它", path)
	}
	return file, nil
}
