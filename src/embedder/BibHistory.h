// Bounded, in-memory navigation history for the standalone browser. Documents
// and form state remain WebCore HistoryItems; this is not a host URL stack.
#pragma once
#include <algorithm>
#include "BackForwardClient.h"
#include "HistoryItem.h"
#include <wtf/Vector.h>
namespace BIB {
class BibHistory final : public WebCore::BackForwardClient {
public:
    static Ref<BibHistory> create() { return adoptRef(*new BibHistory); }
    void addItem(Ref<WebCore::HistoryItem>&& item) final
    {
        if (m_current + 1 < static_cast<int>(m_items.size())) m_items.shrink(m_current + 1);
        m_items.append(WTF::move(item));
        if (m_items.size() > 32) m_items.removeAt(0);
        m_current = static_cast<int>(m_items.size()) - 1;
    }
    // Legacy single-process BackForwardList has this same no-op; child frame
    // history remains part of its root HistoryItem, not a separate browser tab.
    void setChildItem(WebCore::BackForwardFrameItemIdentifier, Ref<WebCore::HistoryItem>&&) final { }
    void goToItem(WebCore::HistoryItem& item) final
    {
        for (size_t i = 0; i < m_items.size(); ++i) if (m_items[i].ptr() == &item) { m_current = i; break; }
    }
    Vector<Ref<WebCore::HistoryItem>> allItems(WebCore::FrameIdentifier) final { return m_items; }
    RefPtr<WebCore::HistoryItem> itemAtIndex(int offset, WebCore::FrameIdentifier) final
    {
        int index = m_current + offset;
        return index >= 0 && index < static_cast<int>(m_items.size()) ? m_items[index].ptr() : nullptr;
    }
    unsigned backListCount() const final { return std::max(0, m_current); }
    unsigned forwardListCount() const final { return m_current < 0 ? 0 : m_items.size() - m_current - 1; }
    bool containsItem(const WebCore::HistoryItem& item) const final
    {
        return m_items.containsIf([&](const auto& entry) { return entry.ptr() == &item; });
    }
    void close() final { m_items.clear(); m_current = -1; }
private:
    Vector<Ref<WebCore::HistoryItem>> m_items;
    int m_current { -1 };
};
}
