const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const id = x => x;
// Mirror the app: factories do NOT invent defaults for omitted fields.
global.App = {
  createRequest: id, createPartialSourceManga: id, createSourceManga: id,
  createMangaInfo: id, createTag: id, createTagSection: id, createChapter: id,
  createChapterDetails: id, createPagedResults: id,
  createHomeSection: i => ({ id: i.id, title: i.title, type: i.type, containsMoreItems: i.containsMoreItems, items: i.items }),
  createRequestManager: (opts) => ({
    getDefaultUserAgent: async () => UA,
    schedule: async (request) => {
      const req = opts.interceptor ? await opts.interceptor.interceptRequest({ ...request }) : request;
      const r = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {} });
      return { data: await r.text(), status: r.status, headers: {}, request: req };
    }
  })
};
const { Sources } = require('D:/Bins Scanlation/paperback-hentainexus/bundles/HentaiNexus/source.js');
(async () => {
  const s = new Sources.HentaiNexus();
  let bad = 0;
  // The app reads .items on every section it receives; undefined is a crash.
  await s.getHomePageSections(sec => {
    const ok = Array.isArray(sec.items);
    if (!ok) bad++;
    console.log(`  callback "${sec.title}": items=${ok ? sec.items.length : 'UNDEFINED <-- would crash'}`);
  });
  console.log(`home sections OK       : ${bad === 0}`);

  const se = await s.getSearchResults({ title: 'glasses', includedTags: [], excludedTags: [], parameters: {} }, undefined);
  console.log(`search                 : ${se.results.length} results`);
  const vm = await s.getViewMoreItems('new', { page: 2 });
  console.log(`viewMore page 2        : ${vm.results.length} results`);
  const d = await s.getMangaDetails('1');
  console.log(`details                : "${d.mangaInfo.titles[0]}" pages=${d.mangaInfo.additionalInfo?.Pages}`);
  const cd = await s.getChapterDetails('1', '1');
  console.log(`chapterDetails         : ${cd.pages.length} pages`);
  if (bad > 0) process.exit(1);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
