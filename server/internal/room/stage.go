package room

import (
	"maps"
	"slices"

	"popcorn/internal/protocol"
)

// camGrab: last grab wins, even if the other person is mid-drag.
func (r *reducer) camGrab(id, camID string) {
	cam, ok := r.s.Cams[camID]
	if !ok {
		return
	}
	cam.Holder = protocol.Ptr(id)
	r.s.Cams[camID] = cam
	r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect, Holder: cam.Holder})
}

// camMove handles cam.move and, with release set, cam.release. Both are
// ignored unless the sender holds the cam.
func (r *reducer) camMove(id, camID string, rect protocol.Rect, release bool) {
	cam, ok := r.s.Cams[camID]
	if !ok || cam.Holder == nil || *cam.Holder != id {
		return
	}
	cam.Rect = ClampCamRect(rect)
	if release {
		cam.Holder = nil
	}
	r.s.Cams[camID] = cam
	r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect, Holder: cam.Holder})
}

func (r *reducer) releaseCamsHeldBy(id string) {
	for _, camID := range slices.Sorted(maps.Keys(r.s.Cams)) {
		cam := r.s.Cams[camID]
		if cam.Holder != nil && *cam.Holder == id {
			cam.Holder = nil
			r.s.Cams[camID] = cam
			r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect})
		}
	}
}

// inkPoints relays a batch to the partner. The server decides color and
// width. Sticky batches are also stored for the snapshot.
func (r *reducer) inkPoints(p Participant, m protocol.InkPoints) {
	r.toOthers(p.ID, protocol.InkPointsRelay{
		From: p.ID, StrokeID: m.StrokeID, Mode: m.Mode, Color: p.Color, Width: InkWidth, Points: m.Points,
	})
	if m.Mode == protocol.InkSticky {
		r.addSticky(p, m)
	}
}

func (r *reducer) addSticky(p Participant, m protocol.InkPoints) {
	i := slices.IndexFunc(r.s.Sticky, func(st protocol.Stroke) bool {
		return st.ID == m.StrokeID && st.Author == p.ID
	})
	if i < 0 {
		r.s.Sticky = append(r.s.Sticky, protocol.Stroke{ID: m.StrokeID, Author: p.ID, Color: p.Color, Width: InkWidth})
		i = len(r.s.Sticky) - 1
	}
	st := &r.s.Sticky[i]
	pts := m.Points[:min(len(m.Points), max(MaxStrokePoints-len(st.Points), 0))]
	st.Points = append(st.Points, pts...)
	r.s.stickyPoints += len(pts)
	r.trimSticky()
}

// trimSticky drops the oldest strokes until both caps are met.
func (r *reducer) trimSticky() {
	drop := 0
	for len(r.s.Sticky)-drop > MaxStickyStrokes || r.s.stickyPoints > MaxStickyPoints {
		r.s.stickyPoints -= len(r.s.Sticky[drop].Points)
		drop++
	}
	if drop > 0 {
		r.s.Sticky = slices.Clone(r.s.Sticky[drop:])
	}
}

func (r *reducer) inkClear(id string) {
	r.s.Sticky, r.s.stickyPoints = nil, 0
	r.broadcast(protocol.InkClearRelay{From: id})
}
