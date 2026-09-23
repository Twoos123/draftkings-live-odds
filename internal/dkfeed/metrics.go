package dkfeed

import (
	"slices"
	"time"
)

// clock maps local times onto DraftKings' clock, so latencies don't depend on
// how well this machine's clock is set.
type clock struct {
	offset time.Duration // add to local time to get DraftKings' time
}

// sync estimates the offset from the subscription round trip. DraftKings
// stamps its ack; assuming it did so halfway between send and receive puts
// the error within half the round trip.
func (c *clock) sync(sentAt, receivedAt, dkStamp time.Time) {
	if dkStamp.IsZero() {
		return
	}
	c.offset = dkStamp.Sub(sentAt.Add(receivedAt.Sub(sentAt) / 2))
}

// latency returns how long an update took to reach us from DraftKings' socket
// server (wire) and from when DraftKings created the change. Missing
// timestamps give 0.
func (c *clock) latency(receivedAt time.Time, f Frame, u *Update) (wire, sinceCreated time.Duration) {
	dkNow := receivedAt.Add(c.offset)
	if !f.WebsocketPublishTimestamp.IsZero() {
		wire = dkNow.Sub(f.WebsocketPublishTimestamp)
		if wire < 0 {
			// A frame can't arrive before it was sent: the offset was too small.
			c.offset -= wire
			dkNow, wire = dkNow.Add(-wire), 0
		}
	}
	if !u.Metadata.CreatedTime.IsZero() {
		sinceCreated = dkNow.Sub(u.Metadata.CreatedTime)
	}
	return wire, sinceCreated
}

// ParseStats collects decode times and reports percentiles.
type ParseStats struct {
	samples []time.Duration
}

func (s *ParseStats) Add(d time.Duration) { s.samples = append(s.samples, d) }

func (s *ParseStats) Len() int { return len(s.samples) }

// Percentile returns the p-th percentile for 0 ≤ p ≤ 1 (1 is the max), or 0
// with no samples.
func (s *ParseStats) Percentile(p float64) time.Duration {
	if len(s.samples) == 0 {
		return 0
	}
	slices.Sort(s.samples)
	return s.samples[min(len(s.samples)-1, int(p*float64(len(s.samples))))]
}
