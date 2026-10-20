#pragma once
#include <wtf/Forward.h>
namespace WebCore { class LocalFrame; }
namespace BIB {
RefPtr<WebCore::LocalFrame> clipboardFrame();
void clipboardTask(int kind, int identifier, const char* text);
void pruneClipboardRequests();
}
