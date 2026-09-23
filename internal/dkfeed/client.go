package dkfeed

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// FeedURL is DraftKings' public push feed for New Jersey (site "dkusnj").
const FeedURL = "wss://sportsbook-ws-us-nj.draftkings.com/websocket?format=json&locale=en"

// Config selects the feed and the subscription. Zero fields use the defaults.
type Config struct {
	URL            string        // default FeedURL
	SiteName       string        // default "dkusnj"; must match the URL's jurisdiction
	Query          string        // events filter; default every NFL event
	IncludeMarkets string        // markets filter; default all but SportcastBetBuilder
	AckTimeout     time.Duration // default 10s
	PingInterval   time.Duration // default 15s; a missing pong ends the connection
}

func (c Config) withDefaults() Config {
	if c.URL == "" {
		c.URL = FeedURL
	}
	if c.SiteName == "" {
		c.SiteName = "dkusnj"
	}
	if c.Query == "" {
		c.Query = "$filter=leagueId eq '88808'"
	}
	if c.IncludeMarkets == "" {
		c.IncludeMarkets = "$filter=tags/all(t: t ne 'SportcastBetBuilder')"
	}
	if c.AckTimeout == 0 {
		c.AckTimeout = 10 * time.Second
	}
	if c.PingInterval == 0 {
		c.PingInterval = 15 * time.Second
	}
	return c
}

func (c Config) subscribeMessage(id string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "subscribe",
		"id":      id,
		"params": map[string]any{
			"entity":   "events",
			"siteName": c.SiteName,
			"queryParams": map[string]any{
				"query":          c.Query,
				"includeMarkets": c.IncludeMarkets,
				"initialData":    false,
				"projection":     "sportsbook",
				"locale":         "en",
			},
		},
	})
	return b
}

// Message is one frame as it arrived. Latencies are on DraftKings' clock.
type Message struct {
	Frame    Frame
	Update   *Update       // set for "update" frames
	Err      error         // set when the frame couldn't be decoded
	Size     int           // bytes
	Received time.Time     // local clock, when the read returned
	Parse    time.Duration // time to decode the frame

	// "subscribed" frames
	RoundTrip   time.Duration // subscribe sent → ack received
	ClockOffset time.Duration // add to local time to get DraftKings' time

	// "update" frames
	Wire         time.Duration // DK's socket server sent it → we received it
	SinceCreated time.Duration // DK's trading system created it → we received it
}

// Client holds one connection with one subscription. It doesn't reconnect:
// Run returns when the connection ends.
type Client struct {
	cfg Config
}

func New(cfg Config) *Client { return &Client{cfg: cfg.withDefaults()} }

// Run connects, subscribes, and calls handle for every frame, in order, on
// Run's goroutine. It returns nil once ctx ends, or an error if the
// connection fails or DraftKings reports one.
func (cl *Client) Run(ctx context.Context, handle func(Message)) error {
	cfg := cl.cfg
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	dialCtx, cancelDial := context.WithTimeout(ctx, 10*time.Second)
	conn, resp, err := websocket.Dial(dialCtx, cfg.URL, nil)
	cancelDial()
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		if resp != nil {
			return fmt.Errorf("connect: HTTP %d: %w", resp.StatusCode, err)
		}
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(16 << 20) // the library's default is 32 KiB

	sentAt := time.Now()
	if err := conn.Write(ctx, websocket.MessageText, cfg.subscribeMessage(newID())); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	var subscribed, timedOut atomic.Bool
	ackTimer := time.AfterFunc(cfg.AckTimeout, func() {
		if !subscribed.Load() {
			timedOut.Store(true)
			conn.CloseNow()
		}
	})
	defer ackTimer.Stop()
	go keepAlive(ctx, conn, cfg.PingInterval)

	var clk clock
	for {
		_, raw, err := conn.Read(ctx)
		recv := time.Now()
		if err != nil {
			switch {
			case ctx.Err() != nil:
				return nil
			case timedOut.Load():
				return fmt.Errorf("DraftKings did not acknowledge the subscription within %s", cfg.AckTimeout)
			case !subscribed.Load():
				return fmt.Errorf("connection ended before DraftKings acknowledged the subscription: %w", err)
			default:
				return fmt.Errorf("read: %w", err)
			}
		}

		f, upd, err := Decode(raw)
		m := Message{Frame: f, Update: upd, Err: err, Size: len(raw), Received: recv, Parse: time.Since(recv)}
		switch {
		case err != nil:
		case f.Event == "subscribed":
			subscribed.Store(true)
			ackTimer.Stop()
			clk.sync(sentAt, recv, f.WebsocketPublishTimestamp)
			m.RoundTrip, m.ClockOffset = recv.Sub(sentAt), clk.offset
		case f.Event == "update":
			m.Wire, m.SinceCreated = clk.latency(recv, f, upd)
		case f.Event == "error":
			return fmt.Errorf("DraftKings feed error: %s", f.Data)
		}
		handle(m)
	}
}

// keepAlive pings every interval. A missing pong closes the connection, which
// ends Run's read.
func keepAlive(ctx context.Context, conn *websocket.Conn, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				conn.CloseNow()
				return
			}
		}
	}
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40 // UUID v4
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
