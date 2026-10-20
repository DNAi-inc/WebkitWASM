// Host-only profile channel. Never installed in the guest JavaScript global.
struct BibProfileTask { char* json; };
static void bibRunProfile(void*);
EMSCRIPTEN_KEEPALIVE void bib_profile_apply(const char* json)
{
    if (!bibOnEngineThread()) {
        if (!json || strlen(json) > 16 * 1024 * 1024) return;
        auto* task = new BibProfileTask { strdup(json) };
        if (!bibProxyToEngine(bibRunProfile, task)) { free(task->json); delete task; }
        return;
    }
    if (!g_engine || !json) return;
    auto parsed = JSON::Value::parseJSON(String::fromUTF8(json));
    auto root = parsed ? parsed->asObject() : nullptr;
    auto before = root ? root->getObject("base"_s) : nullptr;
    auto next = root ? root->getObject("next"_s) : nullptr;
    if (!before || !next) return;
    auto decode = [](JSON::Object& state) {
        HashMap<String, WebCore::Cookie> values;
        if (auto list = state.getArray("cookies"_s)) for (auto& item : *list) {
            auto c = item->asObject(); if (!c) continue;
            WebCore::Cookie cookie;
            cookie.name=c->getString("name"_s); cookie.value=c->getString("value"_s);
            cookie.domain=c->getString("domain"_s); cookie.path=c->getString("path"_s);
            cookie.httpOnly=c->getBoolean("httpOnly"_s).value_or(false);
            cookie.secure=c->getBoolean("secure"_s).value_or(false);
            cookie.session=c->getBoolean("session"_s).value_or(false);
            cookie.expires=c->getDouble("expires"_s);
            auto same=c->getString("sameSite"_s);
            cookie.sameSite=same=="Strict"_s?WebCore::Cookie::SameSitePolicy::Strict:same=="None"_s?WebCore::Cookie::SameSitePolicy::None:WebCore::Cookie::SameSitePolicy::Lax;
            values.set(makeString(cookie.domain,'\n',cookie.path,'\n',cookie.name),WTF::move(cookie));
        }
        return values;
    };
    auto old=decode(*before), desired=decode(*next);
    HashMap<String, WebCore::Cookie> current;
    auto& jar=BIB::embedderStorageSession().cookieDatabase();
    for(auto& c:jar.getAllCookies()) current.set(makeString(c.domain,'\n',c.path,'\n',c.name),c);
    auto same=[](const auto& a,const auto& b){return a.name==b.name&&a.value==b.value&&a.domain==b.domain&&a.path==b.path&&a.expires==b.expires&&a.httpOnly==b.httpOnly&&a.secure==b.secure&&a.session==b.session&&a.sameSite==b.sameSite;};
    HashSet<String> keys;
    for(auto& e:old) keys.add(e.key); for(auto& e:desired) keys.add(e.key);
    for(auto& key:keys){
        auto a=old.find(key),b=desired.find(key),now=current.find(key);
        if(a!=old.end()&&b!=desired.end()&&same(a->value,b->value))continue;
        // Preserve changes the website made while the phone request was in flight.
        if((a==old.end())!=(now==current.end()))continue;
        if(a!=old.end()&&!same(a->value,now->value))continue;
        if(b!=desired.end()) jar.setCookie(b->value);
        else { auto expired=a->value;expired.session=false;expired.expires=0;jar.setCookie(expired); }
    }
    auto storageBefore=before->getObject("localStorage"_s),storageNext=next->getObject("localStorage"_s);
    HashSet<String> origins;
    if(storageBefore)for(auto& e:*storageBefore)origins.add(e.key);
    if(storageNext)for(auto& e:*storageNext)origins.add(e.key);
    for(auto& origin:origins){
        auto a=storageBefore?storageBefore->getObject(origin):nullptr,b=storageNext?storageNext->getObject(origin):nullptr;
        HashMap<String,String> oldItems,newItems,currentItems;
        if(a)for(auto& e:*a)oldItems.set(e.key,e.value->asString());
        if(b)for(auto& e:*b)newItems.set(e.key,e.value->asString());
        auto area=BIB::bibLocalAreaRegistry().get(origin);
        if(area)area->forEachItem([&](const String& k,const String& v){currentItems.set(k,v);});
        else currentItems=BIB::bibPendingStorageImport().get(origin);
        HashSet<String> itemKeys;
        for(auto& e:oldItems)itemKeys.add(e.key);for(auto& e:newItems)itemKeys.add(e.key);
        for(auto& k:itemKeys){
            if(oldItems.get(k)==newItems.get(k)||currentItems.get(k)!=oldItems.get(k))continue;
            if(newItems.contains(k)){currentItems.set(k,newItems.get(k));if(area)area->importItem(k,newItems.get(k));}
            else {currentItems.remove(k);if(area)area->profileRemove(k);}
        }
        if(!area)BIB::bibPendingStorageImport().set(origin,WTF::move(currentItems));
    }
    bibMaybePersist(true);
}
static void bibRunProfile(void* p){auto* task=static_cast<BibProfileTask*>(p);bib_profile_apply(task->json);free(task->json);delete task;}
