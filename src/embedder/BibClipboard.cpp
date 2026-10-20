#include "config.h"
#include "BibClipboard.h"
#include "BibMediaPlayer.h"
#include "Document.h"
#include "Editor.h"
#include "FrameSelection.h"
#include "LocalFrame.h"
#include "LocalFrameInlines.h"
#include "PagePasteboardContext.h"
#include "Pasteboard.h"
#include "VisibleSelection.h"
#include <atomic>
#include <climits>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <wtf/MonotonicTime.h>

namespace WebCore { void setEmscriptenClipboardCutHook(bool (*)(Pasteboard&)); }
namespace {
constexpr size_t maxTextBytes = 4 * 1024 * 1024;
std::atomic<int> activeWrite { 0 }, writeStatus { 0 };
int operation;
bool payloadSent;
struct PasteRequest {
    int identifier;
    RefPtr<WebCore::LocalFrame> frame;
    RefPtr<WebCore::Document> document;
    WebCore::VisibleSelection selection;
    MonotonicTime started;
};
std::unique_ptr<PasteRequest> pasteRequest;
void notify(int identifier, const char* event, const char* text = "")
{
    MAIN_THREAD_EM_ASM({
        if (typeof updateMemoryViews === 'function') updateMemoryViews();
        var host = typeof hostModule !== 'undefined' ? hostModule : Module;
        host.bibClipboardEvent?.($0, UTF8ToString($1), UTF8ToString($2));
    }, identifier, event, text);
}
bool sendText(WebCore::Pasteboard& board)
{
    auto text = board.readString("text/plain"_s);
    if (text.isNull()) { notify(operation, "error", "Nothing to copy"); return false; }
    auto utf8 = text.utf8();
    if (utf8.length() > maxTextBytes) { notify(operation, "error", "Clipboard text is too large"); return false; }
    payloadSent = true;
    notify(operation, "text", utf8.data());
    return true;
}
bool commitCut(WebCore::Pasteboard& board)
{
    // A synchronous engine must never block the browser's main thread.
    if (emscripten_is_main_browser_thread()) { notify(operation, "error", "Cut requires the worker build"); return false; }
    if (!sendText(board)) return false;
    auto start = MonotonicTime::now();
    while (!writeStatus.load(std::memory_order_acquire)) {
        if ((MonotonicTime::now() - start).seconds() >= 30) { notify(operation, "error", "Clipboard write timed out"); return false; }
        emscripten_futex_wait(&writeStatus, 0, 100);
    }
    return writeStatus.load(std::memory_order_acquire) == 1;
}
}
// This callback only changes atomics. It must not queue behind the waiting cut.
extern "C" EMSCRIPTEN_KEEPALIVE void bib_clipboard_write_complete(int identifier, int success)
{
    if (activeWrite.load(std::memory_order_acquire) != identifier) return;
    writeStatus.store(success ? 1 : 2, std::memory_order_release);
    emscripten_futex_wake(&writeStatus, INT_MAX);
}
namespace BIB {
void pruneClipboardRequests()
{
    if (pasteRequest && (MonotonicTime::now() - pasteRequest->started).seconds() > 30)
        pasteRequest = nullptr;
}
void clipboardTask(int kind, int identifier, const char* text)
{
    pruneClipboardRequests();
    if (identifier <= 0) return;
    auto frame = clipboardFrame();
    if (!frame || !frame->document()) { notify(identifier, "error", "No focused document"); return; }
    if (kind == 2) {
        pasteRequest = std::make_unique<PasteRequest>(PasteRequest { identifier, frame, frame->protectedDocument(), frame->selection().selection(), MonotonicTime::now() });
        return;
    }
    if (kind == 4) {
        if (pasteRequest && pasteRequest->identifier == identifier) pasteRequest = nullptr;
        return;
    }
    if (kind == 3) {
        if (!pasteRequest || pasteRequest->identifier != identifier) { notify(identifier, "error", "Paste expired"); return; }
        auto request = WTF::move(pasteRequest);
        if (frame != request->frame || frame->document() != request->document || frame->selection().selection() != request->selection) {
            notify(identifier, "error", "Paste cancelled: selection changed"); return;
        }
        if (!text || strnlen(text, maxTextBytes + 1) > maxTextBytes) { notify(identifier, "error", "Clipboard text is too large"); return; }
        auto board = WebCore::Pasteboard::createForCopyAndPaste(WebCore::PagePasteboardContext::create(frame->document()->pageID()));
        board->writePlainText(String::fromUTF8(text), WebCore::Pasteboard::CannotSmartReplace);
        frame->editor().pasteAsPlainText(WebCore::Editor::FromMenuOrKeyBinding::Yes);
        board->clear();
        notify(identifier, "done");
        return;
    }
    if (kind != 0 && kind != 1) return;
    operation = identifier; payloadSent = false;
    writeStatus.store(0, std::memory_order_release);
    activeWrite.store(identifier, std::memory_order_release);
    auto board = WebCore::Pasteboard::createForCopyAndPaste(WebCore::PagePasteboardContext::create(frame->document()->pageID()));
    board->clear();
    if (kind == 1) {
        WebCore::setEmscriptenClipboardCutHook(commitCut);
        frame->editor().cut(WebCore::Editor::FromMenuOrKeyBinding::Yes);
        WebCore::setEmscriptenClipboardCutHook(nullptr);
    } else frame->editor().copy(WebCore::Editor::FromMenuOrKeyBinding::Yes);
    if (!payloadSent) sendText(*board);
    board->clear();
    activeWrite.store(0, std::memory_order_release);
    notify(identifier, "done");
}
}
