# Profile source modifications: 2026-10-20. Original licences remain applicable.
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[2];out=root/'build/profile-overlay';out.mkdir(parents=True,exist_ok=True)
paths=['src/embedder/main.cpp','src/embedder/BibStorage.h','third_party/WebKit/Source/WebCore/platform/network/curl/CookieJarDB.cpp','third_party/WebKit/Source/WebCore/platform/network/curl/NetworkStorageSessionCurl.cpp']
paths.append('third_party/WebKit/Source/WebCore/platform/network/curl/CookieUtil.cpp')
sources={name:(root/name).read_text() for name in paths}
s=sources[paths[0]]
s=s.replace('c->setBoolean("session"_s, cookie.session);','c->setBoolean("session"_s, cookie.session);\n        c->setString("sameSite"_s, cookie.sameSite==WebCore::Cookie::SameSitePolicy::Strict?"Strict"_s:cookie.sameSite==WebCore::Cookie::SameSitePolicy::Lax?"Lax"_s:"None"_s);')
s=s.replace('cookie.session = c->getBoolean("session"_s).value_or(false);','cookie.session = c->getBoolean("session"_s).value_or(false);\n            auto same=c->getString("sameSite"_s);cookie.sameSite=same=="Strict"_s?WebCore::Cookie::SameSitePolicy::Strict:same=="None"_s?WebCore::Cookie::SameSitePolicy::None:WebCore::Cookie::SameSitePolicy::Lax;')
s=s.replace('lastCheck < Seconds(5)','lastCheck < Seconds(0.5)')
s=s.replace('static void bibRunPersistNow(void*) { bib_persist_now(); }','static void bibRunPersistNow(void*) { bib_persist_now(); }\n'+Path(__file__).with_name('profile-api.cpp.inc').read_text());sources[paths[0]]=s
s=sources[paths[1]].replace('    template<typename Functor> void forEachItem','    void profileRemove(const String& key) { String old; m_map.removeItem(key,old); }\n\n    template<typename Functor> void forEachItem');sources[paths[1]]=s
s=sources[paths[2]]
s=s.replace('"  secure INTEGER NOT NULL DEFAULT 0,"','"  secure INTEGER NOT NULL DEFAULT 0,"\\\n    "  samesite INTEGER NOT NULL DEFAULT 1,"')
s=s.replace('session, httponly, secure) ', 'session, httponly, secure, samesite) ')
s=s.replace('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);','VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);')
s=s.replace('expires, httponly, secure, session FROM Cookie','expires, httponly, secure, session, samesite FROM Cookie')
s=s.replace('cookie.session = cookieSession;', 'cookie.session = cookieSession;\n        cookie.sameSite=static_cast<Cookie::SameSitePolicy>(pstmt->columnInt(8));')
s=s.replace('cookie.session = (pstmt->columnInt(7) == 1);','cookie.session = (pstmt->columnInt(7) == 1);\n        cookie.sameSite=static_cast<Cookie::SameSitePolicy>(pstmt->columnInt(8));')
s=s.replace('statement.bindInt(9, cookie.secure ? 1 : 0);','statement.bindInt(9, cookie.secure ? 1 : 0);\n    statement.bindInt(10, static_cast<int>(cookie.sameSite));')
s=s.replace('MonotonicTime::fromRawSeconds(expires / msPerSecond) <= MonotonicTime::now()', 'WallTime::fromRawSeconds(expires / msPerSecond) <= WallTime::now()')
sources[paths[2]]=s
s=sources[paths[3]].replace('#include "CurlContext.h"','#include "CurlContext.h"\n#include "SameSiteInfo.h"')
s=s.replace('const URL& url, bool forHTTPHeader, IncludeSecureCookies', 'const URL& url, const SameSiteInfo& sameSite, bool forHTTPHeader, IncludeSecureCookies')
s=s.replace('for (const auto& cookie : *result) {','''for (const auto& cookie : *result) {
            if(forHTTPHeader && !sameSite.isSameSite && (cookie.sameSite==Cookie::SameSitePolicy::Strict || (cookie.sameSite==Cookie::SameSitePolicy::Lax && !(sameSite.isTopSite && sameSite.isSafeHTTPMethod))))continue;''')
s=s.replace('const SameSiteInfo&, const URL& url','const SameSiteInfo& sameSite, const URL& url')
s=s.replace('firstParty, url, false, includeSecureCookies','firstParty, url, sameSite, false, includeSecureCookies').replace('firstParty, url, true, includeSecureCookies','firstParty, url, sameSite, true, includeSecureCookies')
sources[paths[3]]=s
s=sources[paths[4]]
s=s.replace('    else if (equalLettersIgnoringASCIICase(attributeName, "secure"_s))', '''    else if (equalLettersIgnoringASCIICase(attributeName, "samesite"_s)) {
        result.sameSite=equalLettersIgnoringASCIICase(attributeValue,"strict"_s)?Cookie::SameSitePolicy::Strict:equalLettersIgnoringASCIICase(attributeValue,"none"_s)?Cookie::SameSitePolicy::None:Cookie::SameSitePolicy::Lax;
    }
    else if (equalLettersIgnoringASCIICase(attributeName, "secure"_s))''')
s=s.replace('    Cookie cookie;','    Cookie cookie;\n    cookie.sameSite=Cookie::SameSitePolicy::Lax;')
sources[paths[4]]=s
manifest=[]
for name,s in sources.items():
 s='// Modified for WebKit/WASM profile experiments on 2026-10-20.\n// Original copyright and licence notices remain below.\n'+s
 dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(s)
 manifest.append({'path':name,'baseSHA256':hashlib.sha256((root/name).read_bytes()).hexdigest(),'overlaySHA256':hashlib.sha256(dest.read_bytes()).hexdigest()})
(out.parent/'overlay.json').write_text(json.dumps(manifest,indent=2)+'\n')
