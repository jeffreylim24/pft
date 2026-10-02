package room

import "popcorn/internal/protocol"

func (r *reducer) playback(id string, m protocol.ClientMsg) {
	switch m := m.(type) {
	case protocol.PlaybackLoad:
		r.setPlayback(protocol.PlaybackState{VideoID: protocol.Ptr(m.VideoID), UpdatedAt: r.now.UnixMilli()})
	case protocol.PlaybackPlay:
		r.command(m.Position, true)
	case protocol.PlaybackPause:
		r.command(m.Position, false)
	case protocol.PlaybackSeek:
		r.command(m.Position, r.s.Playback.Playing)
	case protocol.PlaybackStalled:
		if r.s.Playback.Playing {
			r.autoPause(id)
		}
	case protocol.PlaybackReady:
		r.ready(id)
	}
}

func (r *reducer) setPlayback(pb protocol.PlaybackState) {
	r.s.Playback = pb
	r.broadcast(protocol.PlaybackUpdate{State: pb})
}

// command applies a manual play, pause or seek. It always clears the waiting
// state: a person acting on purpose overrides an auto-pause.
func (r *reducer) command(position float64, playing bool) {
	if r.s.Playback.VideoID == nil {
		return
	}
	pb := r.s.Playback
	pb.Position, pb.Playing, pb.UpdatedAt = position, playing, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}

// autoPause stops playback where it should be right now and waits for id.
func (r *reducer) autoPause(id string) {
	pb := r.s.Playback
	pb.Position = ExpectedPosition(pb, r.now)
	pb.Playing, pb.UpdatedAt = false, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = protocol.Ptr(id), true
	r.setPlayback(pb)
}

func (r *reducer) ready(id string) {
	pb := r.s.Playback
	if pb.Playing || !pb.AutoResume || pb.WaitingFor == nil || *pb.WaitingFor != id {
		return
	}
	pb.Playing, pb.UpdatedAt = true, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}

// stopWaitingFor gives up on someone who has left: the room stays paused.
func (r *reducer) stopWaitingFor(id string) {
	pb := r.s.Playback
	if pb.WaitingFor == nil || *pb.WaitingFor != id {
		return
	}
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}
