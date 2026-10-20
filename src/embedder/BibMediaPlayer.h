// Host decoder adapter for guest HTML audio/video. HTTP bytes use bounded
// guest-loader range requests (curl/Wisp/TLS/cookies/CSP), then a private
// Service Worker gateway feeds the computer browser decoder. Decoded video
// frames paint inside WebCore, preserving the page's own layout and clipping.
// Data/blob sources use the guest loader's existing bounded buffer path.
// Media capabilities reflect the actual host; MSE/EME/MediaStream are separate.
// Host callbacks carry a source generation and are marshalled to the engine
// thread. A decoder can never request an arbitrary URL through this API.

#pragma once

#include "MediaPlayer.h"

namespace BIB {

// Set once in main() from Module.bibMedia before the first MediaPlayer is
// constructed (buildMediaEnginesVector caches its result for the session).
extern bool g_mediaEnabled;

void registerBibMediaEngine(WebCore::MediaEngineRegistrar);

// Cross-thread helpers defined in main.cpp (W-B1 marshaling block) —
// shared so BibMediaPlayer.cpp's bib_media_event export can self-proxy.
void scheduleMediaFrameCallbacks();
bool onEngineThread();
bool proxyToEngine(void (*task)(void*), void* arg);

} // namespace BIB
