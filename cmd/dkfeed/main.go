// Command dkfeed subscribes to DraftKings' public push feed for NFL markets,
// decodes every frame into typed structs, and logs when it arrived, how long
// decoding took, and how long it took to arrive from DraftKings.
//
//	go run ./cmd/dkfeed               # until Ctrl+C
//	go run ./cmd/dkfeed -for 2m       # stop after two minutes
//	go run ./cmd/dkfeed -json         # one JSON line per update on stdout
//
// The log goes to stderr, so -json output can be piped on its own.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/Twoos123/draftkings-live-odds/internal/dkfeed"
)

// jsonLine is one update in -json mode. Latencies are on DraftKings' clock.
type jsonLine struct {
	Received       time.Time      `json:"received"` // local clock
	Bytes          int            `json:"bytes"`
	ParseMicros    float64        `json:"parseUs"`
	WireMs         int64          `json:"wireMs"`
	SinceCreatedMs int64          `json:"sinceCreatedMs"`
	Update         *dkfeed.Update `json:"update"`
}

func main() {
	runFor := flag.Duration("for", 0, "stop after this long (default: until Ctrl+C)")
	jsonOut := flag.Bool("json", false, "write one JSON line per update to stdout; the log keeps only status lines")
	flag.Parse()
	log.SetFlags(0)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if *runFor > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *runFor)
		defer cancel()
	}

	var parse dkfeed.ParseStats
	invalid := 0
	out := json.NewEncoder(os.Stdout)
	log.Printf("%s  connecting to %s", stamp(time.Now()), dkfeed.FeedURL)
	err := dkfeed.New(dkfeed.Config{}).Run(ctx, func(m dkfeed.Message) {
		switch {
		case m.Err != nil:
			invalid++
			log.Printf("%s  invalid frame (%d B): %v", stamp(m.Received), m.Size, m.Err)
		case m.Frame.Event == "subscribed":
			log.Printf("%s  subscribed as %s  round trip %s  clock offset vs DraftKings %+dms",
				stamp(m.Received), m.Frame.ID, ms(m.RoundTrip), m.ClockOffset.Milliseconds())
		case m.Update != nil:
			parse.Add(m.Parse)
			if !*jsonOut {
				logUpdate(m)
				return
			}
			err := out.Encode(jsonLine{
				Received:       m.Received,
				Bytes:          m.Size,
				ParseMicros:    float64(m.Parse.Nanoseconds()) / 1e3,
				WireMs:         m.Wire.Milliseconds(),
				SinceCreatedMs: m.SinceCreated.Milliseconds(),
				Update:         m.Update,
			})
			if err != nil {
				log.Fatalf("writing stdout: %v", err)
			}
		default:
			log.Printf("%s  %s frame (%d B)", stamp(m.Received), m.Frame.Event, m.Size)
		}
	})

	if parse.Len() == 0 {
		log.Printf("no updates received (%d invalid frames)", invalid)
	} else {
		log.Printf("%d updates  parse median %s  p99 %s  max %s  (%d invalid frames)",
			parse.Len(), micros(parse.Percentile(0.5)), micros(parse.Percentile(0.99)), micros(parse.Percentile(1)), invalid)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func logUpdate(m dkfeed.Message) {
	d := m.Update.Data
	log.Printf("%s  update %5d B  parse %8s  wire %5s  created→received %6s  %s",
		stamp(m.Received), m.Size, micros(m.Parse), ms(m.Wire), ms(m.SinceCreated), summary(d))

	for _, mk := range append(d.Add.Markets, d.Change.Markets...) {
		if mk.IsSuspended != nil {
			log.Printf("    market %-12s %-10s suspended=%t", mk.ID, mk.Name, *mk.IsSuspended)
		}
	}
	for _, s := range append(d.Add.Selections, d.Change.Selections...) {
		if s.DisplayOdds == nil {
			continue
		}
		line := s.Label
		if s.Points != nil {
			line += fmt.Sprintf(" %+g", *s.Points)
		}
		note := ""
		if s.ReplacedSelectionID != "" {
			note = "  replaces " + string(s.ReplacedSelectionID)
		}
		log.Printf("    %-24s %6s  %s%s", line, s.DisplayOdds.American, s.ID, note)
	}
}

// summary counts events/markets/selections added, changed and removed.
func summary(d dkfeed.Delta) string {
	var parts []string
	part := func(verb string, e, m, s int) {
		if e+m+s > 0 {
			parts = append(parts, fmt.Sprintf("%s %de/%dm/%ds", verb, e, m, s))
		}
	}
	part("add", len(d.Add.Events), len(d.Add.Markets), len(d.Add.Selections))
	part("change", len(d.Change.Events), len(d.Change.Markets), len(d.Change.Selections))
	part("remove", len(d.Remove.Events), len(d.Remove.Markets), len(d.Remove.Selections))
	return strings.Join(parts, "  ")
}

func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000Z") }

func ms(d time.Duration) string { return fmt.Sprintf("%dms", d.Milliseconds()) }

func micros(d time.Duration) string { return fmt.Sprintf("%.1fµs", float64(d.Nanoseconds())/1e3) }
