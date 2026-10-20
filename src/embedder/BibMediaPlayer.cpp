// Host-decoded audio/video, guest-owned networking and WebCore video painting.
//
// All WebCore state stays on the engine thread. Host controls are proxied to
// browser main; host events/frames carry a source generation and self-proxy
// back before touching a player. HTTP uses bounded range clients; guest blob/
// data resources use the original bounded whole-buffer path. No author URL is
// fetched in the host realm. The host owns decoding/clock, WebCore owns DOM
// semantics, rendering and request policy.

#include "config.h"
#include <algorithm>

#include "BibMediaPlayer.h"
#include "BibMediaSource.h"

#include "ContentType.h"
#include "DestinationColorSpace.h"
#include "GraphicsContext.h"
#include "HTTPHeaderNames.h"
#include "NativeImage.h"
#include "VideoFrameMetadata.h"
#include "VideoPlaybackQualityMetrics.h"
#include "ParsedContentRange.h"
#include <wtf/JSONValues.h>
#include <wtf/text/MakeString.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkImageInfo.h>
#include <skia/core/SkPixmap.h>
#include "FrameLoaderTypes.h" // ShouldContinuePolicyCheck
#include "MediaPlayerPrivate.h"
#include "NetworkLoadMetrics.h"
#include "PlatformMediaResourceLoader.h"
#include "PlatformTimeRanges.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SecurityOrigin.h"
#include "SharedBuffer.h"
#include <cmath>
#include <cstring>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/MonotonicTime.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/StringHash.h>
#include <wtf/text/WTFString.h>

namespace BIB {

bool g_mediaEnabled = false;

using namespace WebCore;

// Event codes shared with web/browser.html's bibMediaWire() — keep in sync.
enum BibMediaEvent {
    EvLoadedMetadata = 1, // a = duration
    EvCanPlay = 2,
    EvCanPlayThrough = 3,
    EvPlaying = 4,
    EvPause = 5,
    EvTimeUpdate = 6, // a = currentTime
    EvEnded = 7, // a = currentTime
    EvError = 8, // a = MediaError.code (1 aborted, 2 network, 3 decode, 4 src)
    EvDurationChange = 9, // a = duration
    EvProgress = 10, // a = range start, b = range end
    EvSeeked = 11, // a = currentTime
    EvVideoSize = 12,
    EvWaiting = 13,
    EvClearBuffered = 14,
    EvPlayRejected = 15,
    EvRateChange = 16,
    EvQuality = 17,
    EvLoadedData = 18,
};

class BibMediaPlayer;
static HashMap<int, BibMediaPlayer*>& playerRegistry()
{
    static NeverDestroyed<HashMap<int, BibMediaPlayer*>> registry;
    return registry;
}

// Guest-loader path for data/blob resources only. This legacy path buffers
// up to 64 MiB; HTTP media instead uses BibMediaChunkClient below.
class BibMediaResourceClient final : public PlatformMediaResourceClient {
public:
    BibMediaResourceClient(BibMediaPlayer&, int generation);

private:
    void responseReceived(PlatformMediaResource&, const ResourceResponse&, CompletionHandler<void(ShouldContinuePolicyCheck)>&&) final;
    void redirectReceived(PlatformMediaResource&, ResourceRequest&&, const ResourceResponse&, CompletionHandler<void(ResourceRequest&&)>&&) final;
    void dataReceived(PlatformMediaResource&, const SharedBuffer&) final;
    void loadFailed(PlatformMediaResource&, const ResourceError&) final;
    void accessControlCheckFailed(PlatformMediaResource&, const ResourceError&) final;
    void loadFinished(PlatformMediaResource&, const NetworkLoadMetrics&) final;

    WeakPtr<BibMediaPlayer> m_player;
    int m_generation;
};

// One bounded byte-range request. No host fetch and no whole-resource cache.
class BibMediaChunkClient final : public PlatformMediaResourceClient {
public:
    BibMediaChunkClient(BibMediaPlayer&, int generation, int request, int64_t offset, size_t length);
private:
    void responseReceived(PlatformMediaResource&, const ResourceResponse&, CompletionHandler<void(ShouldContinuePolicyCheck)>&&) final;
    void redirectReceived(PlatformMediaResource&, ResourceRequest&&, const ResourceResponse&, CompletionHandler<void(ResourceRequest&&)>&&) final;
    void dataReceived(PlatformMediaResource&, const SharedBuffer&) final;
    void loadFailed(PlatformMediaResource&, const ResourceError&) final;
    void accessControlCheckFailed(PlatformMediaResource&, const ResourceError&) final;
    void loadFinished(PlatformMediaResource&, const NetworkLoadMetrics&) final;
    void finish(bool success);
    WeakPtr<BibMediaPlayer> m_player;
    int m_generation, m_request;
    int64_t m_offset, m_total { 0 }, m_expectedLength { 0 };
    size_t m_limit;
    int m_status { 0 };
    String m_mime;
    SharedBufferBuilder m_bytes;
    bool m_finished { false };
};

// Host canPlayType answers, cached per full content-type string: the query
// is a SYNC proxy hop to the main thread (bibHTML pattern) and supportsType
// runs for every <source> candidate.
static int hostCanPlayType(const String& contentType)
{
    static NeverDestroyed<HashMap<String, int>> cache;
    return cache.get().ensure(contentType, [&] {
        CString utf8 = contentType.utf8();
        return MAIN_THREAD_EM_ASM_INT({
            return (typeof Module !== "undefined" && Module && Module.bibMediaCanPlay)
                ? Module.bibMediaCanPlay(UTF8ToString($0)) : 0;
        }, utf8.data());
    }).iterator->value;
}

class BibMediaPlayer final
    : public MediaPlayerPrivateInterface
    , public CanMakeWeakPtr<BibMediaPlayer>
    , public RefCounted<BibMediaPlayer> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(BibMediaPlayer);

public:
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    explicit BibMediaPlayer(MediaPlayer& player)
        : m_player(player)
        , m_id(++s_nextID)
    {
        playerRegistry().set(m_id, this);
        MAIN_THREAD_ASYNC_EM_ASM({
            if (Module.bibMediaCreate) Module.bibMediaCreate($0);
        }, m_id);
    }

    // EXTERNAL_HOLEPUNCH is off in this build, so nothing downcasts on this
    // value — reusing it avoids patching the MediaPlayerType enum.
    constexpr MediaPlayerType mediaPlayerType() const final { return MediaPlayerType::HolePunch; }

    void load(const String& urlString) final
    {
        resetResourceState(); // src change must not bleed prior state (Codex)
        m_networkState = MediaPlayer::NetworkState::Loading;
        auto player = m_player.get();
        URL url { String { urlString } };
        if (!player || !url.isValid()) {
            m_networkState = MediaPlayer::NetworkState::FormatError;
            if (player)
                player->networkStateChanged();
            return;
        }
        int context, source;
        if (resolveMediaSourceURL(urlString, player->documentSecurityOrigin(), context, source)) {
            MAIN_THREAD_ASYNC_EM_ASM({
                if (Module.bibMSEAttach) Module.bibMSEAttach($0, $1, $2, $3);
            }, m_id, m_generation, context, source);
            player->networkStateChanged(); return;
        }
        m_url = url;
        if (!m_loader)
            m_loader = player->mediaResourceLoader();
        if (url.protocolIsInHTTPFamily()) {
            MAIN_THREAD_ASYNC_EM_ASM({
                if (Module.bibMediaLoad) Module.bibMediaLoad($0, $1);
            }, m_id, m_generation);
            player->networkStateChanged();
            return;
        }
        // Blob/data resources still resolve in the guest loader, not host URL space.
        ResourceRequest request { WTF::move(url) };
        request.setAllowCookies(true);
        m_resource = m_loader->requestResource(WTF::move(request), PlatformMediaResourceLoader::BufferData);
        if (!m_resource) {
            m_networkState = MediaPlayer::NetworkState::NetworkError;
            player->networkStateChanged();
            return;
        }
        m_resource->setClient(adoptRef(*new BibMediaResourceClient(*this, m_generation)));
        player->networkStateChanged();
    }

    bool acceptsGeneration(int generation) const { return generation == m_generation; }
    void mediaResponseOrigin(const ResourceResponse& response)
    {
        if (response.url().protocolIsInHTTPFamily())
            m_responseOrigins.add(SecurityOrigin::create(response.url())->data());
    }
    std::optional<bool> isCrossOrigin(const SecurityOrigin& origin) const final
    {
        // Tighten the default for redirected responses. Never return false:
        // otherwise WebCore applies its original URL/CORS tainting decision.
        for (const auto& responseOrigin : m_responseOrigins)
            if (responseOrigin != origin.data()) return true;
        return std::nullopt;
    }
    // --- BibMediaResourceClient callbacks (engine thread) ---------------
    void mediaResponseReceived(const ResourceResponse& response)
    {
        m_mimeType = response.mimeType();
        if (response.httpStatusCode() >= 400)
            m_httpFailed = true; // body may still stream; verdict at finish
    }

    void mediaDataReceived(const SharedBuffer& buffer)
    {
        m_data.append(buffer);
        m_didProgress = true;
        if (m_data.size() > kMaxMediaBytes) {
            // Bounded: the whole file crosses the wasm heap + the JS heap.
            // Streams/giant files fail like a network error until M-C MSE.
            shutdownResource();
            mediaLoadFailed();
        }
    }

    void mediaLoadFailed()
    {
        m_data.reset();
        m_networkState = MediaPlayer::NetworkState::NetworkError;
        if (auto player = m_player.get())
            player->networkStateChanged();
    }

    void mediaLoadFinished()
    {
        if (m_httpFailed) {
            mediaLoadFailed();
            return;
        }
        auto buffer = m_data.takeBufferAsContiguous();
        size_t size = buffer->size();
        char* copy = static_cast<char*>(malloc(size ? size : 1));
        char* mimeCopy = strdup(m_mimeType.utf8().data());
        if (!copy || !mimeCopy) {
            free(copy);
            free(mimeCopy);
            mediaLoadFailed();
            return;
        }
        memcpy(copy, buffer->span().data(), size);
        // Cross-heap push (bibPushFrameIfDirty protocol): main thread
        // copies the bytes OUT of the shared heap (Blob over a SAB view is
        // rejected, same as ImageData) and frees both allocations.
        MAIN_THREAD_ASYNC_EM_ASM({
            if (typeof growMemViews === "function") growMemViews();
            var bytes = HEAPU8.slice($1, $1 + $2);
            var mime = UTF8ToString($3);
            _bib_wasm_free($1);
            _bib_wasm_free($3);
            if (typeof Module !== "undefined" && Module && Module.bibMediaLoadBytes)
                Module.bibMediaLoadBytes($0, $4, bytes, mime);
        }, m_id, copy, (int)size, mimeCopy, m_generation);
    }
#if ENABLE(MEDIA_SOURCE)
    void load(const URL&, const LoadOptions&, MediaSourcePrivateClient&) final { } // M-C
#endif
#if ENABLE(MEDIA_STREAM)
    void load(MediaStreamPrivate&) final { }
#endif
    void cancelLoad() final { resetResourceState(); }

    ~BibMediaPlayer() override
    {
        shutdownResource();
        shutdownChunks();
        playerRegistry().remove(m_id);
        MAIN_THREAD_ASYNC_EM_ASM({
            if (Module.bibMediaDestroy) Module.bibMediaDestroy($0);
        }, m_id);
    }

    void play() final
    {
        m_paused = false;
        m_ended = false;
        ctl(1);
    }
    void pause() final
    {
        m_currentTime = currentTime().toDouble();
        m_clockAdvancing = false;
        m_paused = true;
        ctl(2);
    }
    bool paused() const final { return m_paused; }

    void seekToTarget(const SeekTarget& target) final
    {
        m_seeking = true;
        double t = target.time.toDouble();
        m_currentTime = t;
        ctl(3, t);
    }
    bool seeking() const final { return m_seeking; }

    void setVolumeDouble(double volume) final { ctl(4, volume); }
    void setMuted(bool muted) final { ctl(5, muted ? 1.0 : 0.0); }
    void setRateDouble(double rate) final
    {
        m_currentTime = currentTime().toDouble(); m_clockSample = MonotonicTime::now();
        m_rate = rate; ctl(6, rate);
    }
    double rate() const final { return m_rate; }

    MediaTime duration() const final { return toMediaTime(m_duration); }
    MediaTime currentTime() const final
    {
        double time = m_currentTime;
        if (m_clockAdvancing && !m_paused && !m_seeking)
            time += std::clamp((MonotonicTime::now() - m_clockSample).seconds(), 0.0, 0.5) * m_rate;
        if (std::isfinite(m_duration) && m_duration >= 0) time = std::min(time, m_duration);
        return toMediaTime(std::max(0.0, time));
    }
    MediaTime maxTimeSeekable() const final { return duration(); }

    FloatSize naturalSize() const final { return m_naturalSize; }
    bool hasVideo() const final { return !m_naturalSize.isEmpty(); }
    bool hasAudio() const final { return true; }
    bool ended() const final { return m_ended; }

    void setPreload(MediaPlayer::Preload preload) final { ctl(8, static_cast<int>(preload)); }
    // Hidden videos can feed canvas and requestVideoFrameCallback consumers.
    void setPageIsVisible(bool) final { }

    MediaPlayer::NetworkState networkState() const final { return m_networkState; }
    MediaPlayer::ReadyState readyState() const final { return m_readyState; }

    const PlatformTimeRanges& buffered() const final { return m_buffered; }
    bool didLoadingProgress() const final { return std::exchange(m_didProgress, false); }

    void setPresentationSize(const IntSize& size) final
    {
        MAIN_THREAD_ASYNC_EM_ASM({
            if (Module.bibMediaResize) Module.bibMediaResize($0, $1, $2, $3);
        }, m_id, m_generation, size.width(), size.height());
    }
    void paint(GraphicsContext& context, const FloatRect& rect) final
    {
        if (m_frame)
            context.drawNativeImage(*m_frame, rect, FloatRect { { }, FloatSize { m_frame->size() } });
    }
    RefPtr<NativeImage> nativeImageForCurrentTime() final { return m_frame; }
    bool hasAvailableVideoFrame() const final { return !!m_frame; }

    void startVideoFrameMetadataGathering() final { m_gathering = true; m_lastMetadataFrame = m_frameCount; }
    void stopVideoFrameMetadataGathering() final { m_gathering = false; }
    std::optional<VideoFrameMetadata> videoFrameMetadata() final
    {
        if (!m_frameMetadata || m_lastMetadataFrame == m_frameCount) return std::nullopt;
        m_lastMetadataFrame = m_frameCount; return m_frameMetadata;
    }
    std::optional<VideoPlaybackQualityMetrics> videoPlaybackQualityMetrics() final
    {
        return m_hasQuality ? std::optional<VideoPlaybackQualityMetrics> { m_quality } : std::nullopt;
    }
    unsigned decodedFrameCount() const final { return m_quality.totalVideoFrames; }
    unsigned droppedFrameCount() const final { return m_quality.droppedVideoFrames; }
    void acceptFrame(int generation, unsigned char* pixels, int width, int height, double mediaTime)
    {
        if (generation != m_generation || width < 1 || height < 1 || width > 1920 || height > 1080) {
            free(pixels);
            return;
        }
        SkPixmap pixmap(SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType), pixels, width * 4);
        auto image = SkImages::RasterFromPixmap(pixmap, [](const void* bytes, void*) { free(const_cast<void*>(bytes)); }, nullptr);
        if (!image) { free(pixels); return; }
        m_frame = NativeImage::create(WTF::move(image));
        VideoFrameMetadata metadata;
        metadata.presentationTime = MonotonicTime::now().secondsSinceEpoch().seconds();
        metadata.expectedDisplayTime = metadata.presentationTime;
        metadata.width = m_naturalSize.width(); metadata.height = m_naturalSize.height();
        metadata.mediaTime = mediaTime; metadata.presentedFrames = ++m_frameCount;
        m_frameMetadata = metadata;
        if (m_gathering) scheduleMediaFrameCallbacks();
        if (auto player = m_player.get()) {
            if (m_readyState < MediaPlayer::ReadyState::HaveCurrentData) {
                m_readyState = MediaPlayer::ReadyState::HaveCurrentData;
                player->readyStateChanged();
            }
            if (m_frameCount == 1) player->firstVideoFrameAvailable();
            player->repaint();
        }
    }

    void requestChunk(int generation, int requestID, double offset, int length)
    {
        if (generation != m_generation || !m_loader || !m_url.protocolIsInHTTPFamily() || !std::isfinite(offset)
            || offset < 0 || offset > 9007199254740991.0 || std::floor(offset) != offset
            || length < 1 || length > 256 * 1024 || m_chunks.size() >= 8) {
            completeChunk(requestID, 0, 0, 0, emptyString(), nullptr);
            return;
        }
        ResourceRequest request { URL { m_url } };
        request.setAllowCookies(true);
        request.setHTTPHeaderField(HTTPHeaderName::Range, makeString("bytes="_s, static_cast<int64_t>(offset), '-', static_cast<int64_t>(offset) + length - 1));
        auto resource = m_loader->requestResource(WTF::move(request), PlatformMediaResourceLoader::DisallowCaching);
        if (!resource) { completeChunk(requestID, 0, 0, 0, emptyString(), nullptr); return; }
        m_chunks.set(requestID, resource);
        resource->setClient(adoptRef(*new BibMediaChunkClient(*this, generation, requestID, static_cast<int64_t>(offset), length)));
    }
    void cancelChunk(int generation, int requestID)
    {
        if (generation != m_generation) return;
        if (auto resource = m_chunks.take(requestID)) resource->shutdown();
    }
    void finishChunk(int generation, int requestID, int status, int64_t offset, int64_t total, const String& mime, RefPtr<SharedBuffer>&& bytes)
    {
        if (generation != m_generation || !m_chunks.contains(requestID)) return;
        completeChunk(requestID, status, offset, total, mime, WTF::move(bytes));
        cancelChunk(generation, requestID);
    }

    DestinationColorSpace colorSpace() final { return DestinationColorSpace::SRGB(); }

    void handleEvent(int generation, int code, double a, double b)
    {
        if (generation != m_generation) return;
        auto player = m_player.get();
        switch (code) {
        case EvLoadedMetadata:
            m_duration = a;
            m_readyState = MediaPlayer::ReadyState::HaveMetadata;
            if (player) {
                player->durationChanged();
                player->readyStateChanged();
                player->characteristicChanged();
            }
            break;
        case EvCanPlay:
            // Leave Loading here too: hosts may never fire canplaythrough
            // (streams), which would strand the guest in NETWORK_LOADING
            // (Codex). The host element owns the actual fetch state anyway.
            if (m_networkState == MediaPlayer::NetworkState::Loading)
                m_networkState = MediaPlayer::NetworkState::Idle;
            if (m_readyState < MediaPlayer::ReadyState::HaveFutureData)
                m_readyState = MediaPlayer::ReadyState::HaveFutureData;
            if (player) {
                player->readyStateChanged();
                player->networkStateChanged();
            }
            break;
        case EvCanPlayThrough:
            m_readyState = MediaPlayer::ReadyState::HaveEnoughData;
            if (m_networkState == MediaPlayer::NetworkState::Loading)
                m_networkState = MediaPlayer::NetworkState::Idle;
            if (player) {
                player->readyStateChanged();
                player->networkStateChanged();
            }
            break;
        case EvPlaying:
            m_clockAdvancing = true; m_clockSample = MonotonicTime::now();
            m_paused = false;
            if (player)
                player->playbackStateChanged();
            break;
        case EvPause:
            m_clockAdvancing = false;
            m_paused = true;
            if (player)
                player->playbackStateChanged();
            break;
        case EvTimeUpdate:
            // Cache only: HTMLMediaElement polls currentTime on its own
            // timer; timeChanged() is reserved for discontinuities.
            m_currentTime = a; m_clockSample = MonotonicTime::now();
            m_didProgress = true;
            break;
        case EvEnded:
            m_clockAdvancing = false;
            m_currentTime = a;
            m_ended = true;
            m_paused = true;
            if (player)
                player->timeChanged(); // element checks ended() here
            break;
        case EvError:
            m_clockAdvancing = false;
            m_networkState = a == 3 ? MediaPlayer::NetworkState::DecodeError
                : a == 4 ? MediaPlayer::NetworkState::FormatError
                         : MediaPlayer::NetworkState::NetworkError;
            if (player)
                player->networkStateChanged();
            break;
        case EvDurationChange:
            m_duration = a;
            if (player)
                player->durationChanged();
            break;
        case EvProgress:
            m_buffered.add(toMediaTime(a), toMediaTime(b));
            m_didProgress = true;
            break;
        case EvSeeked:
            m_seeking = false;
            m_currentTime = a; m_clockSample = MonotonicTime::now();
            if (player)
                player->timeChanged();
            break;
        case EvVideoSize:
            m_naturalSize = FloatSize { static_cast<float>(a), static_cast<float>(b) };
            if (player) { player->sizeChanged(); player->characteristicChanged(); player->repaint(); }
            break;
        case EvWaiting:
            m_clockAdvancing = false;
            if (m_readyState >= MediaPlayer::ReadyState::HaveCurrentData)
                m_readyState = MediaPlayer::ReadyState::HaveCurrentData;
            if (player) player->readyStateChanged();
            break;
        case EvClearBuffered:
            m_buffered = PlatformTimeRanges { };
            break;
        case EvPlayRejected:
            m_clockAdvancing = false;
            m_paused = true;
            if (player) player->playbackStateChanged();
            break;
        case EvLoadedData:
            // Audio has no frame callback; video promotes readiness only after
            // its pixels have reached WebCore, so loadeddata can draw to canvas.
            if (!hasVideo() && m_readyState < MediaPlayer::ReadyState::HaveCurrentData) {
                m_readyState = MediaPlayer::ReadyState::HaveCurrentData;
                if (player) player->readyStateChanged();
            }
            break;
        case EvQuality:
            m_quality.totalVideoFrames = static_cast<uint32_t>(std::clamp(a, 0.0, 4294967295.0));
            m_quality.droppedVideoFrames = static_cast<uint32_t>(std::clamp(b, 0.0, a));
            m_hasQuality = true;
            break;
        case EvRateChange:
            m_currentTime = currentTime().toDouble(); m_clockSample = MonotonicTime::now();
            m_rate = a;
            if (player) player->rateChanged();
            break;
        default:
            (void)b;
            break;
        }
    }

private:
    void completeChunk(int requestID, int status, int64_t offset, int64_t total, const String& mime, RefPtr<SharedBuffer>&& data)
    {
        auto info = JSON::Object::create();
        info->setInteger("status"_s, status);
        info->setDouble("offset"_s, offset);
        info->setDouble("total"_s, total);
        info->setString("mime"_s, mime);
        char* json = strdup(info->toJSONString().utf8().data());
        auto buffer = data ? data->makeContiguous() : SharedBuffer::create();
        size_t size = buffer->size();
        auto* bytes = static_cast<unsigned char*>(malloc(size ? size : 1));
        if (!json || !bytes) { free(json); free(bytes); return; }
        if (size) memcpy(bytes, buffer->span().data(), size);
        MAIN_THREAD_ASYNC_EM_ASM({
            if (typeof growMemViews === "function") growMemViews();
            var info = JSON.parse(UTF8ToString($1));
            var bytes = HEAPU8.slice($2, $2 + $3);
            _bib_wasm_free($1); _bib_wasm_free($2);
            if (Module.bibMediaChunk) Module.bibMediaChunk($0, info, bytes);
        }, requestID, json, bytes, static_cast<int>(size));
    }
    void shutdownChunks()
    {
        auto chunks = WTF::move(m_chunks);
        for (auto& entry : chunks) entry.value->shutdown();
    }
    // Data/blob fallback only; HTTP does not accumulate whole files here.
    static constexpr size_t kMaxMediaBytes = 64 * 1024 * 1024;

    void shutdownResource()
    {
        if (m_resource) {
            m_resource->shutdown();
            m_resource = nullptr;
        }
    }

    // Per-resource state must not bleed across src changes (Codex).
    void resetResourceState()
    {
        shutdownResource();
        shutdownChunks();
        m_loader = nullptr; // a new source may change the element's CORS mode
        m_url = URL { };
        ++m_generation;
        ctl(7); // unload even if the replacement URL is invalid or cannot load
        m_frame = nullptr;
        m_frameMetadata.reset(); m_frameCount = 0; m_lastMetadataFrame = 0; m_hasQuality = false; m_quality = { };
        m_naturalSize = { };
        m_responseOrigins.clear();
        m_data.reset();
        m_mimeType = String();
        m_httpFailed = false;
        m_networkState = MediaPlayer::NetworkState::Empty;
        m_readyState = MediaPlayer::ReadyState::HaveNothing;
        m_duration = 0;
        m_currentTime = 0;
        m_clockAdvancing = false; m_clockSample = MonotonicTime::now();
        m_paused = true;
        m_seeking = false;
        m_ended = false;
        m_didProgress = false;
        m_buffered = PlatformTimeRanges { };
    }

    // op codes shared with browser.html bibMediaCtl: 1 play, 2 pause,
    // 3 seek(a), 4 volume(a), 5 muted(a), 6 rate(a), 7 unload.
    void ctl(int op, double a = 0)
    {
        MAIN_THREAD_ASYNC_EM_ASM({
            if (Module.bibMediaCtl) Module.bibMediaCtl($0, $1, $2, $3);
        }, m_id, m_generation, op, a);
    }

    static MediaTime toMediaTime(double seconds)
    {
        if (std::isnan(seconds))
            return MediaTime::zeroTime();
        if (std::isinf(seconds))
            return MediaTime::positiveInfiniteTime();
        return MediaTime::createWithDouble(seconds);
    }

    ThreadSafeWeakPtr<MediaPlayer> m_player;
    int m_id { 0 };
    int m_generation { 0 };
    URL m_url;
    HashSet<SecurityOriginData> m_responseOrigins;
    FloatSize m_naturalSize;
    RefPtr<NativeImage> m_frame;
    std::optional<VideoFrameMetadata> m_frameMetadata;
    VideoPlaybackQualityMetrics m_quality;
    unsigned m_frameCount { 0 }, m_lastMetadataFrame { 0 };
    bool m_gathering { false }, m_hasQuality { false };
    HashMap<int, RefPtr<PlatformMediaResource>> m_chunks;
    static int s_nextID;

    // Wisp-routed fetch state (engine thread only).
    RefPtr<PlatformMediaResourceLoader> m_loader;
    RefPtr<PlatformMediaResource> m_resource;
    SharedBufferBuilder m_data;
    String m_mimeType;
    bool m_httpFailed { false };

    MediaPlayer::NetworkState m_networkState { MediaPlayer::NetworkState::Empty };
    MediaPlayer::ReadyState m_readyState { MediaPlayer::ReadyState::HaveNothing };
    double m_duration { 0 };
    double m_currentTime { 0 };
    double m_rate { 1 };
    bool m_clockAdvancing { false };
    MonotonicTime m_clockSample { MonotonicTime::now() };
    bool m_paused { true };
    bool m_seeking { false };
    bool m_ended { false };
    mutable bool m_didProgress { false };
    PlatformTimeRanges m_buffered;
};

int BibMediaPlayer::s_nextID = 0;

BibMediaResourceClient::BibMediaResourceClient(BibMediaPlayer& player, int generation)
    : m_player(player)
    , m_generation(generation)
{
}

void BibMediaResourceClient::responseReceived(PlatformMediaResource&, const ResourceResponse& response, CompletionHandler<void(ShouldContinuePolicyCheck)>&& completionHandler)
{
    auto player = m_player.get();
    if (!player || !player->acceptsGeneration(m_generation)) { completionHandler(ShouldContinuePolicyCheck::No); return; }
    player->mediaResponseOrigin(response);
    player->mediaResponseReceived(response);
    completionHandler(ShouldContinuePolicyCheck::Yes);
}

void BibMediaResourceClient::redirectReceived(PlatformMediaResource&, ResourceRequest&& request, const ResourceResponse& response, CompletionHandler<void(ResourceRequest&&)>&& completion)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation)) player->mediaResponseOrigin(response);
    completion(WTF::move(request));
}

void BibMediaResourceClient::dataReceived(PlatformMediaResource&, const SharedBuffer& buffer)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation))
        player->mediaDataReceived(buffer);
}

void BibMediaResourceClient::loadFailed(PlatformMediaResource&, const ResourceError&)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation))
        player->mediaLoadFailed();
}

void BibMediaResourceClient::accessControlCheckFailed(PlatformMediaResource&, const ResourceError&)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation))
        player->mediaLoadFailed();
}

void BibMediaResourceClient::loadFinished(PlatformMediaResource&, const NetworkLoadMetrics&)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation))
        player->mediaLoadFinished();
}

BibMediaChunkClient::BibMediaChunkClient(BibMediaPlayer& player, int generation, int request, int64_t offset, size_t length)
    : m_player(player), m_generation(generation), m_request(request), m_offset(offset), m_limit(length) { }

void BibMediaChunkClient::responseReceived(PlatformMediaResource&, const ResourceResponse& response, CompletionHandler<void(ShouldContinuePolicyCheck)>&& completion)
{
    Ref protectedThis { *this };
    auto player = m_player.get();
    if (!player || !player->acceptsGeneration(m_generation)) { completion(ShouldContinuePolicyCheck::No); finish(false); return; }
    player->mediaResponseOrigin(response);
    m_status = response.httpStatusCode();
    m_mime = response.mimeType();
    const auto& range = response.contentRange();
    bool valid = false;
    if (m_status == 206 && range.isValid() && range.firstBytePosition() == m_offset
        && range.instanceLength() > 0 && range.instanceLength() < 9007199254740991LL
        && range.lastBytePosition() >= m_offset && range.lastBytePosition() < range.instanceLength() && range.lastBytePosition() - m_offset < static_cast<int64_t>(m_limit)) {
        m_total = range.instanceLength(); m_expectedLength = range.lastBytePosition() - m_offset + 1; valid = true;
    } else if (m_status == 200 && !m_offset && response.expectedContentLength() > 0
        && response.expectedContentLength() <= static_cast<int64_t>(m_limit)) {
        m_total = response.expectedContentLength(); m_expectedLength = m_total; valid = true;
    }
    completion(valid ? ShouldContinuePolicyCheck::Yes : ShouldContinuePolicyCheck::No);
    if (!valid) finish(false);
}
void BibMediaChunkClient::redirectReceived(PlatformMediaResource&, ResourceRequest&& request, const ResourceResponse& response, CompletionHandler<void(ResourceRequest&&)>&& completion)
{
    if (auto player = m_player.get(); player && player->acceptsGeneration(m_generation)) player->mediaResponseOrigin(response);
    completion(WTF::move(request));
}
void BibMediaChunkClient::dataReceived(PlatformMediaResource&, const SharedBuffer& data)
{
    if (m_finished) return;
    if (data.size() > m_limit - m_bytes.size()) { finish(false); return; }
    m_bytes.append(data);
}
void BibMediaChunkClient::loadFailed(PlatformMediaResource&, const ResourceError&) { finish(false); }
void BibMediaChunkClient::accessControlCheckFailed(PlatformMediaResource&, const ResourceError&) { finish(false); }
void BibMediaChunkClient::loadFinished(PlatformMediaResource&, const NetworkLoadMetrics&) { finish(true); }
void BibMediaChunkClient::finish(bool success)
{
    if (std::exchange(m_finished, true)) return;
    // The client can be released by shutdown(), so keep it alive through finish.
    Ref protectedThis { *this };
    auto data = m_bytes.takeBufferAsContiguous();
    if (auto player = m_player.get())
        player->finishChunk(m_generation, m_request, success && static_cast<int64_t>(data->size()) == m_expectedLength ? m_status : 0, m_offset, m_total, m_mime, WTF::move(data));
}

class BibMediaPlayerFactory final : public MediaPlayerFactory {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(BibMediaPlayerFactory);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(BibMediaPlayerFactory);

private:
    MediaPlayerEnums::MediaEngineIdentifier identifier() const final { return MediaPlayerEnums::MediaEngineIdentifier::HolePunch; }

    Ref<MediaPlayerPrivateInterface> createMediaEnginePlayer(MediaPlayer& player) const final
    {
        return adoptRef(*new BibMediaPlayer(player));
    }

    void getSupportedTypes(HashSet<String>& types) const final
    {
        // Candidate inventory filtered by the HOST's truthful answers.
        static constexpr ASCIILiteral candidates[] = {
            "audio/mpeg"_s, "audio/mp4"_s, "audio/aac"_s, "audio/ogg"_s,
            "audio/wav"_s, "audio/x-wav"_s, "audio/webm"_s, "audio/flac"_s,
            "video/mp4"_s, "video/webm"_s, "video/ogg"_s,
        };
        for (auto& mime : candidates) {
            if (hostCanPlayType(mime))
                types.add(mime);
        }
    }

    MediaPlayer::SupportsType supportsTypeAndCodecs(const MediaEngineSupportParameters& parameters) const final
    {
        if (parameters.isMediaSource || parameters.isMediaStream)
            return MediaPlayer::SupportsType::IsNotSupported;
        // Advertise only containers the host decoder actually supports.
        if (!parameters.type.containerType().startsWith("audio/"_s) && !parameters.type.containerType().startsWith("video/"_s))
            return MediaPlayer::SupportsType::IsNotSupported;
        switch (hostCanPlayType(parameters.type.raw())) {
        case 2:
            return MediaPlayer::SupportsType::IsSupported;
        case 1:
            return MediaPlayer::SupportsType::MayBeSupported;
        default:
            return MediaPlayer::SupportsType::IsNotSupported;
        }
    }
};

void registerBibMediaEngine(MediaEngineRegistrar registrar)
{
    if (!g_mediaEnabled)
        return;
    registrar(makeUnique<BibMediaPlayerFactory>());
}

} // namespace BIB

// JS->C event channel: the host element's listeners call this from the
// BROWSER MAIN thread; self-proxy to the engine thread before touching the
// registry (which is engine-thread-only).
extern "C" {

struct BibMediaEventTask {
    int id;
    int generation;
    int code;
    double a;
    double b;
};

static void bibRunMediaEvent(void* p)
{
    auto* task = static_cast<BibMediaEventTask*>(p);
    if (auto* player = BIB::playerRegistry().get(task->id))
        player->handleEvent(task->generation, task->code, task->a, task->b);
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_media_event(int id, int generation, int code, double a, double b)
{
    if (BIB::onEngineThread()) {
        if (auto* player = BIB::playerRegistry().get(id))
            player->handleEvent(generation, code, a, b);
        return;
    }
    auto* task = new BibMediaEventTask { id, generation, code, a, b };
    if (!BIB::proxyToEngine(bibRunMediaEvent, task))
        delete task;
}

struct BibMediaReadTask { int id, generation, request, length; double offset; bool cancel; };
static void bibRunMediaRead(void* pointer)
{
    auto* task = static_cast<BibMediaReadTask*>(pointer);
    if (auto* player = BIB::playerRegistry().get(task->id)) {
        if (task->cancel) player->cancelChunk(task->generation, task->request);
        else player->requestChunk(task->generation, task->request, task->offset, task->length);
    }
    delete task;
}
EMSCRIPTEN_KEEPALIVE void bib_media_request(int id, int generation, int request, double offset, int length)
{
    auto* task = new BibMediaReadTask { id, generation, request, length, offset, false };
    if (BIB::onEngineThread()) bibRunMediaRead(task);
    else if (!BIB::proxyToEngine(bibRunMediaRead, task)) delete task;
}
EMSCRIPTEN_KEEPALIVE void bib_media_cancel(int id, int generation, int request)
{
    auto* task = new BibMediaReadTask { id, generation, request, 0, 0, true };
    if (BIB::onEngineThread()) bibRunMediaRead(task);
    else if (!BIB::proxyToEngine(bibRunMediaRead, task)) delete task;
}
struct BibMediaFrameTask { int id, generation, width, height; unsigned char* pixels; double mediaTime; };
static void bibRunMediaFrame(void* pointer)
{
    auto* task = static_cast<BibMediaFrameTask*>(pointer);
    if (auto* player = BIB::playerRegistry().get(task->id))
        player->acceptFrame(task->generation, task->pixels, task->width, task->height, task->mediaTime);
    else free(task->pixels);
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.bibMediaFrameDone) Module.bibMediaFrameDone($0, $1);
    }, task->id, task->generation);
    delete task;
}
EMSCRIPTEN_KEEPALIVE void bib_media_frame(int id, int generation, unsigned char* pixels, int width, int height, double mediaTime)
{
    auto* task = new BibMediaFrameTask { id, generation, width, height, pixels, mediaTime };
    if (BIB::onEngineThread()) bibRunMediaFrame(task);
    else if (!BIB::proxyToEngine(bibRunMediaFrame, task)) { free(pixels); delete task; }
}

} // extern "C"
