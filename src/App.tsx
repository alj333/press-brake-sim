import { useEffect, useState } from 'react';
import { loadOcct, OCCT_PARAMS } from './core/import/occt-loader';

export default function App() {
  const [msg, setMsg] = useState('loading');
  useEffect(() => {
    (async () => {
      try {
        const occt = await loadOcct();
        const res = await fetch('/samples/L-bracket.step');
        const buf = new Uint8Array(await res.arrayBuffer());
        const r = occt.ReadStepFile(buf, OCCT_PARAMS);
        setMsg(`occt ok: faces=${r.meshes[0].brep_faces.length}`);
      } catch (e) { setMsg('error: ' + String(e)); }
    })();
  }, []);
  return <div id="status">{msg}</div>;
}
