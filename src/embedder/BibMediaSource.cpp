// MSE control adapter. Guest fetch/XHR resolves media in WebCore; append bytes
// are copied to a host MediaSource. Original HTMLVideoElement is never replaced.
#include "config.h"
#include "BibMediaSource.h"
#include "BibMediaPlayer.h"
#include "Document.h"
#include "DOMWrapperWorld.h"
#include "JSDOMConvertBufferSource.h"
#include "JSDOMGlobalObject.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "FrameDestructionObserverInlines.h"
#include "ScriptController.h"
#include "SecurityOrigin.h"
#include <JavaScriptCore/CallFrameInlines.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSFunction.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/WeakPtr.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>
#include <cstdlib>
#include <cstring>

namespace BIB {
using namespace WebCore;
struct MediaContext {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(MediaContext);
public:
    MediaContext(int identifier, Document* owner) : id(identifier), document(owner) { }
    int id;
    WeakPtr<Document, WeakPtrImplWithEventTargetData> document;
    HashSet<int> sources;
};
struct MediaURL { int context, source; };
static HashMap<JSC::JSGlobalObject*, std::unique_ptr<MediaContext>>& contexts()
{
    static NeverDestroyed<HashMap<JSC::JSGlobalObject*, std::unique_ptr<MediaContext>>> value; return value;
}
static HashMap<String, MediaURL>& urls()
{
    static NeverDestroyed<HashMap<String, MediaURL>> value; return value;
}
static int nextContext;
static void disposeContext(JSC::JSGlobalObject* key)
{
    auto context = contexts().take(key); if (!context) return;
    Vector<String> removed;
    for (const auto& entry : urls()) if (entry.value.context == context->id) removed.append(entry.key);
    for (const auto& url : removed) urls().remove(url);
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.bibMSEDispose) Module.bibMSEDispose($0); }, context->id);
}
void pruneMediaSourceContexts()
{
    Vector<JSC::JSGlobalObject*> dead;
    for (auto& entry : contexts()) {
        auto* document = entry.value->document.get();
        if (!document || !document->frame() || document->frame()->document() != document) dead.append(entry.key);
    }
    for (auto* key : dead) disposeContext(key);
}
bool resolveMediaSourceURL(const String& url, const SecurityOriginData& origin, int& context, int& source)
{
    auto found = urls().find(url); if (found == urls().end()) return false;
    // Additional restriction: never attach another origin's decoder. The
    // caller still passes through HTMLMediaElement's normal URL/CSP checks.
    for (const auto& entry : contexts()) {
        auto* document = entry.value->document.get();
        if (entry.value->id == found->value.context && document && document->securityOrigin().data() == origin) {
            context = found->value.context; source = found->value.source; return true;
        }
    }
    return false;
}
static JSC::EncodedJSValue reply(JSC::VM& vm, const String& text) { return JSC::JSValue::encode(JSC::jsString(vm, text)); }
JSC_DEFINE_HOST_FUNCTION(mediaSourceCommand, (JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame))
{
    auto& vm = globalObject->vm(); auto scope = DECLARE_THROW_SCOPE(vm);
    // Resolve ownership from the native function's own realm, never an author ID.
    auto* owner = callFrame->jsCallee()->globalObject();
    auto found = contexts().find(owner);
    const String invalid = "{\"ok\":false,\"name\":\"InvalidStateError\",\"message\":\"Media context unavailable\"}"_s;
    if (found == contexts().end() || !found->value->document) return reply(vm, invalid);
    auto& context = *found->value;
    String commandText = callFrame->argument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    if (commandText.length() > 8192) return reply(vm, invalid);
    auto parsed = JSON::Value::parseJSON(commandText);
    auto command = parsed ? parsed->asObject() : nullptr;
    if (!command) return reply(vm, invalid);
    String op = command->getString("op"_s);
    int source = command->getInteger("source"_s).value_or(0);
    if (op == "register"_s) {
        String value = command->getString("value"_s); URL url { value };
        if (!context.sources.contains(source) || !url.protocolIsBlob() || !context.document->securityOrigin().isSameOriginAs(SecurityOrigin::create(url).get()) || urls().size() >= 256) return reply(vm, invalid);
        urls().set(value, MediaURL { context.id, source }); return reply(vm, "{\"ok\":true}"_s);
    }
    if (op == "unregister"_s) {
        String value = command->getString("value"_s); auto entry = urls().find(value);
        if (entry != urls().end() && entry->value.context == context.id) urls().remove(entry);
        return reply(vm, "{\"ok\":true}"_s);
    }
    if (op == "create"_s) {
        if (source < 1 || context.sources.size() >= 8 || context.sources.contains(source)) return reply(vm, invalid);
    } else if (op != "supported"_s && !context.sources.contains(source)) return reply(vm, invalid);
    RefPtr<JSC::ArrayBufferView> bytes;
    if (op == "append"_s) {
        bytes = toUnsharedArrayBufferView(vm, callFrame->argument(1));
        if (!bytes || bytes->byteLength() > 16 * 1024 * 1024) return reply(vm, invalid);
    }
    CString utf8 = commandText.utf8();
    constexpr int capacity = 64 * 1024;
    char* result = static_cast<char*>(malloc(capacity)); if (!result) return reply(vm, invalid);
    MAIN_THREAD_EM_ASM({
        if (typeof growMemViews === "function") growMemViews();
        var result;
        try {
            var bytes = JSON.parse(UTF8ToString($1)).op === 'append' ? HEAPU8.slice($2, $2 + $3) : undefined;
            result = Module.bibMSECommand ? Module.bibMSECommand($0, UTF8ToString($1), bytes) : '{"ok":false}';
        } catch (error) { result = JSON.stringify({ ok: false, name: error.name, message: error.message }); }
        if (lengthBytesUTF8(result) >= $5) result = '{"ok":false,"name":"QuotaExceededError"}';
        stringToUTF8(result, $4, $5);
    }, context.id, utf8.data(), bytes ? bytes->data() : nullptr, bytes ? bytes->byteLength() : 0, result, capacity);
    String output = String::fromUTF8(result); free(result);
    auto resultValue = JSON::Value::parseJSON(output);
    if (resultValue && resultValue->asObject() && resultValue->asObject()->getBoolean("ok"_s).value_or(false)) {
        if (op == "create"_s) context.sources.add(source);
        if (op == "release"_s) context.sources.remove(source);
    }
    return reply(vm, output);
}
void injectMediaSourceBridge(LocalFrame& frame, DOMWrapperWorld& world)
{
    if (!g_mediaEnabled || &world != &mainThreadNormalWorldSingleton()) return;
    static String source = [] {
        int bytes = MAIN_THREAD_EM_ASM_INT({ return Module.bibMSE && Module.bibMSEPolyfill ? lengthBytesUTF8(Module.bibMSEPolyfill) + 1 : 0; });
        if (!bytes) return String();
        char* text = static_cast<char*>(malloc(bytes)); if (!text) return String();
        MAIN_THREAD_EM_ASM({ stringToUTF8(Module.bibMSEPolyfill, $0, $1); }, text, bytes);
        String value = String::fromUTF8(text); free(text); return value;
    }();
    if (source.isEmpty() || !frame.document()) return;
    pruneMediaSourceContexts();
    auto* global = frame.script().globalObject(world); if (!global) return;
    disposeContext(global); // document.open can reuse the same global/document
    if (contexts().size() >= 32) return;
    contexts().set(global, makeUnique<MediaContext>(++nextContext, frame.document()));
    JSC::VM& vm = global->vm(); JSC::JSLockHolder lock(vm);
    global->putDirect(vm, JSC::Identifier::fromString(vm, "__bibMediaSourceCommand"_s), JSC::JSFunction::create(vm, global, 2, "__bibMediaSourceCommand"_s, mediaSourceCommand, JSC::ImplementationVisibility::Public), static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
    frame.script().executeScriptIgnoringException(String { source }, JSC::SourceTaintedOrigin::Untainted);
}
static void deliverMediaSourceEvent(int id, const char* text)
{
    if (!text || strlen(text) > 64 * 1024) return;
    // Re-serialize through the JSON parser before constructing a script. Never
    // concatenate host strings as executable JavaScript.
    auto value = JSON::Value::parseJSON(String::fromUTF8(text)); if (!value || !value->asObject()) return;
    for (const auto& entry : contexts()) {
        const auto& context = *entry.value; if (context.id != id) continue;
        auto* document = context.document.get();
        if (!document || !document->frame() || document->frame()->document() != document) return;
        document->frame()->script().executeScriptIgnoringException(makeString("globalThis.__bibMSEDispatch("_s, value->toJSONString(), ")"_s), JSC::SourceTaintedOrigin::Untainted);
        return;
    }
}
} // namespace BIB
extern "C" {
struct BibMSEEventTask { int context; char* text; };
static void bibRunMSEEvent(void* pointer)
{
    auto* task = static_cast<BibMSEEventTask*>(pointer);
    BIB::deliverMediaSourceEvent(task->context, task->text); free(task->text); delete task;
}
EMSCRIPTEN_KEEPALIVE void bib_mse_event(int context, char* text)
{
    auto* task = new BibMSEEventTask { context, text };
    if (BIB::onEngineThread()) bibRunMSEEvent(task);
    else if (!BIB::proxyToEngine(bibRunMSEEvent, task)) { free(text); delete task; }
}
}
