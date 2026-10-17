import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from '../../src/sqlite.js';

/** Synthetic browser profiles (no real browsing data) in the layouts Chromium and Firefox use. */
const chromeTime = iso => String((Date.parse(iso) + 11644473600000) * 1000);
const firefoxTime = iso => Date.parse(iso) * 1000;

export function chromiumProfile(home, { browserRoot = '.config/google-chrome', profile = 'Default', name = 'Work person' } = {}) {
  const root = join(home, browserRoot);
  const path = join(root, profile);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { [profile]: { name } } } }));
  writeFileSync(join(path, 'Bookmarks'), JSON.stringify({ checksum: 'x', version: 1, roots: {
    bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
      { type: 'url', name: 'Example docs', url: 'https://docs.example.com/guide', date_added: chromeTime('2026-01-02T03:04:05Z'), guid: 'a', id: '1', meta_info: { power_bookmark: '1' } },
      { type: 'folder', name: 'Research', children: [
        { type: 'url', name: 'Paper', url: 'https://papers.example.org/1?token=secret-value&page=2', date_added: chromeTime('2026-02-01T00:00:00Z') },
        { type: 'url', name: 'Duplicate docs', url: 'https://docs.example.com/guide' },
        { type: 'url', name: 'Script', url: 'javascript:alert(1)' },
        { type: 'url', name: 'Signed in', url: 'https://user:pass@private.example.net/' },
      ] },
    ] },
    other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'Existing', url: 'https://existing.example.com/' }] },
    synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
  } }));
  const db = new DatabaseSync(join(path, 'History'));
  db.exec('CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0); CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);');
  const insert = db.prepare('INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)');
  insert.run('https://docs.example.com/guide', 'Example docs', 4, chromeTime('2026-03-01T10:00:00Z'), 0);
  insert.run('https://news.example.com/today', 'Today', 1, chromeTime('2026-03-02T10:00:00Z'), 0);
  insert.run('https://hidden.example.com/', 'Hidden frame', 1, chromeTime('2026-03-02T11:00:00Z'), 1);
  insert.run('file:///etc/passwd', 'Local file', 1, chromeTime('2026-03-02T12:00:00Z'), 0);
  db.close();
  // Secret-bearing files that must never be opened.
  for (const file of ['Login Data', 'Cookies', 'Web Data', 'Current Session']) writeFileSync(join(path, file), 'SECRET-SENTINEL');
  return path;
}

export function firefoxProfile(home, { name = 'default-release' } = {}) {
  const root = join(home, '.mozilla/firefox');
  const path = join(root, `abcd1234.${name}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'profiles.ini'), `[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=${name}\nIsRelative=1\nPath=abcd1234.${name}\nDefault=1\n`);
  writeFileSync(join(path, 'containers.json'), JSON.stringify({ version: 4, identities: [
    { userContextId: 1, public: true, icon: 'fingerprint', color: 'blue', l10nID: 'userContextPersonal.label' },
    { userContextId: 2, public: true, icon: 'briefcase', color: 'orange', name: 'Work' },
    { userContextId: 4294967295, public: false, name: 'userContextIdInternal.thumbnail' },
  ] }));
  const db = new DatabaseSync(join(path, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
    CREATE TABLE moz_keywords(id INTEGER PRIMARY KEY, keyword TEXT, place_id INTEGER);`);
  const place = db.prepare('INSERT INTO moz_places(id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)');
  place.run(1, 'https://mdn.example.org/docs', 'Reference docs', 3, 0, firefoxTime('2026-04-01T09:00:00Z'));
  place.run(2, 'https://shop.example.com/cart', 'Cart', 1, 0, firefoxTime('2026-04-02T09:00:00Z'));
  place.run(3, 'https://tagged.example.com/', 'Tagged', 0, 0, null);
  const mark = db.prepare('INSERT INTO moz_bookmarks(id, type, fk, parent, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  mark.run(1, 2, null, 0, '', 0, 'root________');
  mark.run(2, 2, null, 1, 'menu', 0, 'menu________');
  mark.run(3, 2, null, 1, 'toolbar', 0, 'toolbar_____');
  mark.run(4, 2, null, 1, 'tags', 0, 'tags________');
  mark.run(5, 2, null, 3, 'Reading', firefoxTime('2026-01-01T00:00:00Z'), 'reading_____');
  mark.run(6, 1, 1, 5, 'Reference docs', firefoxTime('2026-01-05T00:00:00Z'), 'bm1_________');
  mark.run(7, 3, null, 3, '', 0, 'separator___');
  mark.run(8, 2, null, 4, 'later', 0, 'tag_later___');
  mark.run(9, 1, 3, 8, null, 0, 'tagentry____');
  mark.run(10, 1, 2, 2, 'Cart', firefoxTime('2026-02-01T00:00:00Z'), 'bm2_________');
  db.prepare('INSERT INTO moz_keywords(keyword, place_id) VALUES (?, ?)').run('docs', 1);
  db.close();
  for (const file of ['logins.json', 'key4.db', 'cookies.sqlite', 'formhistory.sqlite', 'sessionstore.jsonlz4']) writeFileSync(join(path, file), 'SECRET-SENTINEL');
  return path;
}

export function netscapeFile(directory) {
  const path = join(directory, 'bookmarks.html');
  writeFileSync(path, `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Toolbar &amp; more</H3>
  <DL><p>
    <DT><A HREF="https://blog.example.com/post?a=1&amp;b=2" ADD_DATE="1700000100" ICON="data:image/png;base64,AAAA" TAGS="x,y">Blog &lt;post&gt;</A>
    <DT><A HREF="https://blog.example.com/post?a=1&amp;b=2" ADD_DATE="1700000200">Same post</A>
  </DL><p>
  <DT><A HREF="place:sort=8" ADD_DATE="1700000300">Recent</A>
  <DT><A HREF="https://plain.example.com/" ADD_DATE="1700000400" SHORTCUTURL="p">Plain</A>
</DL><p>
`);
  return path;
}
