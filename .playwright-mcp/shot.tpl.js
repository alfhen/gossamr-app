async (page) => {
  const W = __W__, SCHEME = '__SCHEME__', TAB = '__TAB__', TAG = '__TAG__';
  const dir = '/private/tmp/claude-502/-Users-alfhenderson-Code-jira-inbox/ca57f134-1d1b-4967-ae70-94aac413c177/scratchpad/';
  await page.emulateMedia({ colorScheme: SCHEME });
  await page.setViewportSize({ width: W, height: 1000 });
  await page.goto('http://localhost:1530/');
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const { useWorkspace } = await import('/src/workspaceStore.ts');
    const st = useWorkspace.getState();
    const base = Object.values(st.items).find(i => i.status.category === 'active');
    const titles = ["Custom Klaviyo MCP gateway + n8n fan-out","Harden the incognito-app against reload-storm traffic bursts (2026-09-21 incident follow-up)","Customer Experience","Restructure the gateway's tool surface and async workflow","SRE/DevOps","Upgrade laravel/mcp from 0.3.4 to 1.0","Tiny","Another small epic","Payments","Search relevance tuning for multilingual catalogues across every storefront","Onboarding","Data platform","Mobile","Docs"];
    const sizes = [6,9,3,7,4,2,1,1,5,12,2,3,1,2];
    const cats = ['todo','active','done'];
    const items = { ...st.items };
    const now = Date.now();
    let n = 0;
    titles.forEach((t, ci) => {
      const pk = `ZZ-${100+ci}`;
      const parentRef = { connectionId:'mock', externalId: pk, key: pk };
      items['mock:'+pk] = { ...base, item: parentRef, kind:'epic', title:t, parent:null, links:[] };
      for (let k=0;k<sizes[ci];k++) {
        const key = `ZZ-${1000+n}`; n++;
        const c = cats[(k+ci)%3];
        const status = Object.assign({}, base.status, { category:c, name: c==='done'?'Done':c==='todo'?'To Do':'In Progress', id:'x'+c });
        const ref = { connectionId:'mock', externalId:key, key };
        const links = (k>0 && k%2===0) ? [{ from: ref, to:{ connectionId:'mock', externalId:`ZZ-${1000+n-2}`, key:'' }, kind:'blocks' }] : [];
        items['mock:'+key] = { ...base, item: ref, parent: parentRef, title:`Ticket ${key} with a realistic long-ish title`, status, links, commentCount:k%5, updated: new Date(now - (6+(k%5))*86400000).toISOString() };
      }
    });
    useWorkspace.setState({ items });
  });
  await page.getByText('Map', { exact: true }).first().click();
  await page.getByText(TAB).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}${TAG}-${W}-${SCHEME}-${TAB.replace(/\W/g,'')}.png` });
  return await page.evaluate(() => {
    const rs = [...document.querySelectorAll('[data-cluster-label]')].map(g => { const r = g.getBoundingClientRect(); return { r, t: g.textContent }; });
    const out = [];
    for (let i=0;i<rs.length;i++) for (let j=i+1;j<rs.length;j++) { const a=rs[i].r,b=rs[j].r; if (a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5) out.push([rs[i].t, rs[j].t]); }
    return { clusters: rs.length, overlaps: out };
  });
}
