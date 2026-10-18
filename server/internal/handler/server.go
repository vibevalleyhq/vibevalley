package handler

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/workspace"
)

// Server owns the listener, farm and request lifetime; completion means both transport and farm have stopped.
type Server struct {
	address string
	done    chan struct{}
	err     error
}

func Listen(ctx context.Context, cfg base.Config, options ...fx.Option) (*Server, error) {
	listener, err := net.Listen("tcp", cfg.ServerAddress())
	if err != nil {
		return nil, err
	}
	life, cancel := context.WithCancel(ctx)
	result := &Server{address: listener.Addr().String(), done: make(chan struct{})}
	var transport *http.Server
	served := make(chan error, 1)
	started := false
	prepare := base.BeforeReady(func(context.Context) error {
		started = true
		go func() { served <- transport.Serve(listener) }()
		return nil
	})
	farm, err := workspace.New(cfg, append([]fx.Option{prepare}, options...)...)
	if err != nil {
		cancel()
		listener.Close()
		return nil, err
	}
	farm.Session.SetAddress(result.address)
	transport = &http.Server{Handler: New(farm), BaseContext: func(net.Listener) context.Context { return life }}
	if err := farm.Start(life); err != nil {
		cancel()
		transport.Close()
		listener.Close()
		if started {
			<-served
		}
		farm.Close()
		return nil, err
	}
	go func() {
		var serveErr error
		exited := false
		select {
		case serveErr = <-served:
			exited = true
		case <-life.Done():
		}
		cancel()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		err := transport.Shutdown(shutdown)
		stop()
		if err != nil {
			transport.Close()
		}
		if !exited {
			serveErr = <-served
		}
		farm.Close()
		if !errors.Is(serveErr, http.ErrServerClosed) {
			result.err = serveErr
		}
		result.err = errors.Join(result.err, err)
		close(result.done)
	}()
	return result, nil
}

func (s *Server) Address() string { return s.address }

func (s *Server) Wait() error {
	<-s.done
	return s.err
}
