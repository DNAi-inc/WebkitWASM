#pragma once
#include <wtf/Forward.h>
namespace WebCore { class LocalFrame; class DOMWrapperWorld; class SecurityOriginData; }
namespace BIB {
void injectMediaSourceBridge(WebCore::LocalFrame&, WebCore::DOMWrapperWorld&);
void pruneMediaSourceContexts();
bool resolveMediaSourceURL(const String&, const WebCore::SecurityOriginData&, int& context, int& source);
}
