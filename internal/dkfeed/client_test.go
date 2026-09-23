package dkfeed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeFeed serves one websocket: it checks the subscribe message, then hands
// the connection to serve. Returns the ws:// URL.
func fakeFeed(t *testing.T, serve func(ctx context.Context, c *websocket.Conn, subID string)) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer c.CloseNow()
		_, raw, err := c.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		var sub struct {
			Method string `json:"method"`
			ID     string `json:"id"`
			Params struct {
				SiteName    string `json:"siteName"`
				QueryParams struct {
					Query string `json:"query"`
				} `json:"queryParams"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &sub); err != nil {
			t.Error(err)
			return
		}
		if sub.Method != "subscribe" || sub.ID == "" || sub.Params.SiteName != "dkusnj" ||
			sub.Params.QueryParams.Query != "$filter=leagueId eq '88808'" {
			t.Errorf("unexpected subscribe message: %s", raw)
		}
		serve(r.Context(), c, sub.ID)
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func send(ctx context.Context, c *websocket.Conn, format string, args ...any) {
	c.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(format, args...)))
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func TestRunDeliversAckThenUpdates(t *testing.T) {
	url := fakeFeed(t, func(ctx context.Context, c *websocket.Conn, subID string) {
		send(ctx, c, `{"id":%q,"event":"subscribed","data":"","websocketPublishTimestamp":%q}`, subID, stamp(time.Now()))
		now := time.Now()
		send(ctx, c, `{"id":%q,"event":"update","data":{"data":{"change":{"selections":[{"id":"0ML1_1","displayOdds":{"american":"−110"}}]}},"metadata":{"createdTime":%q}},"websocketPublishTimestamp":%q}`,
			subID, stamp(now.Add(-50*time.Millisecond)), stamp(now))
		c.Read(ctx) // until the client closes
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var got []Message
	err := New(Config{URL: url}).Run(ctx, func(m Message) {
		got = append(got, m)
		if m.Update != nil {
			cancel()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Frame.Event != "subscribed" || got[1].Update == nil {
		t.Fatalf("want an ack then an update, got %+v", got)
	}
	if got[0].RoundTrip < 0 { // 0 is possible on loopback with Windows' clock
		t.Errorf("round trip %s", got[0].RoundTrip)
	}
	u := got[1]
	if sel := u.Update.Data.Change.Selections; len(sel) != 1 || sel[0].DisplayOdds.American != "−110" {
		t.Errorf("selections %+v", sel)
	}
	// Created 50 ms before it was sent; same machine, so the clocks agree.
	if u.Wire < 0 || u.SinceCreated < 40*time.Millisecond || u.SinceCreated > 2*time.Second {
		t.Errorf("wire %s, since created %s", u.Wire, u.SinceCreated)
	}
}

func TestRunFailsWithoutAck(t *testing.T) {
	url := fakeFeed(t, func(ctx context.Context, c *websocket.Conn, _ string) {
		c.Read(ctx) // never acknowledge
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := New(Config{URL: url, AckTimeout: 100 * time.Millisecond}).Run(ctx, func(Message) {})
	if err == nil || !strings.Contains(err.Error(), "did not acknowledge") {
		t.Fatalf("got %v", err)
	}
}

func TestRunReturnsFeedErrors(t *testing.T) {
	url := fakeFeed(t, func(ctx context.Context, c *websocket.Conn, subID string) {
		send(ctx, c, `{"id":%q,"event":"error","data":"invalid filter"}`, subID)
		c.Read(ctx)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := New(Config{URL: url}).Run(ctx, func(Message) {})
	if err == nil || !strings.Contains(err.Error(), "invalid filter") {
		t.Fatalf("got %v", err)
	}
}
