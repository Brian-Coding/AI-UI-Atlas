import { performance } from 'node:perf_hooks';
const root = process.argv[2] || process.cwd();
const { queryAtlas, clickPath } = await import(root + '/src/atlas/atlas-search.ts');
const graph = { schemaVersion: 1, runId: 'benchmark', generatedAt: '2026-01-01T00:00:00Z', entities: [],
  surfaces: Array.from({length: 2000}, (_,i) => ({ id: 'surface.screen-'+i, name: 'Screen '+i, status:'verified', route:i===0?'/':undefined })),
  flows: Array.from({length: 1999}, (_,i) => ({ id:'flow.next-'+i, name:'Next '+i, fromSurfaceId:'surface.screen-'+i, toSurfaceId:'surface.screen-'+(i+1) })) };
const median = (a:number[]) => a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
for (const [name, operation] of [['navigation', () => clickPath(graph, 'surface.screen-1999')], ['query', () => queryAtlas(graph, 'how do I get to surface.screen-1999')]] as const) {
  for(let i=0;i<5;i++) operation();
  const values=[]; for(let i=0;i<25;i++){const t=performance.now();operation();values.push(performance.now()-t);}
  console.log(JSON.stringify({name,median_ms:median(values),samples:values.length}));
}
