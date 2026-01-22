import { useEffect, useMemo, useRef, useState } from 'react';

function loadScriptOnce(src) {
  if (typeof window === 'undefined') return Promise.reject(new Error('Not in browser'));

  // already loaded
  if (window.GGBApplet) return Promise.resolve();

  // already loading
  if (window.__ggbDeployLoadingPromise) return window.__ggbDeployLoadingPromise;

  window.__ggbDeployLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ggb-deploy="true"][src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`加载 GeoGebra 脚本失败：${src}`)));
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.setAttribute('data-ggb-deploy', 'true');
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载 GeoGebra 脚本失败：${src}`));
    document.head.appendChild(script);
  });

  return window.__ggbDeployLoadingPromise;
}

function safeCall(api, name, ...args) {
  try {
    const fn = api?.[name];
    if (typeof fn === 'function') return fn.apply(api, args);
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * GeoGebra Applet React 组件
 *
 * 两种模式：
 * - `mode="iframe"`：用本地 `GeoGebra.html`（Classic 完整 UI，最接近官网体验）；同域可拿到 `ggbApplet`。
 * - `mode="deploy"`：用 `deployggb.js` 注入（更轻量，适合无 UI 的“画布模式”）。
 */
export default function Geogebra({
  mode = 'iframe',
  width = '100%',
  height = '100%',

  // deploy 模式参数
  codebase = '/geogebra/HTML5/5.0/web3d/',
  appName = 'classic',

  // UI 开关（两种模式都会尽力应用）
  showToolBar = true,
  showMenuBar = true,
  showAlgebraInput = true,
  allowStyleBar = true,
  enableLabelDrags = true,
  enableShiftDragZoom = true,
  enableRightClick = true,
  showResetIcon = true,

  // iframe 模式参数
  iframeSrc,

  // 调试
  debug = false,

  onApiReady,
  onError
}) {
  const [status, setStatus] = useState('init'); // init | loading | ready | error
  const [debugSnapshot, setDebugSnapshot] = useState(null);

  const containerId = useMemo(() => `ggb-${Math.random().toString(36).slice(2)}-${Date.now()}`, []);
  const appletRef = useRef(null);
  const iframeRef = useRef(null);

  // 避免把父组件的回调函数引用放进注入 effect 依赖（会导致反复重建）
  const onApiReadyRef = useRef(onApiReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onApiReadyRef.current = onApiReady;
  }, [onApiReady]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // ------------------------
  // iframe 模式（推荐：完整 UI）
  // ------------------------
  const computedIframeSrc = useMemo(() => {
    if (mode !== 'iframe') return null;
    if (iframeSrc) return iframeSrc;

    // 关键点：GeoGebra.html 会在“没有 filename/state/command”时进入 apps picker。
    // 我们通过带一个 `command=1` 来触发 skipAppsPicker，从而直接进入 classic。
    return `/geogebra/HTML5/5.0/GeoGebra.html?command=1`;
  }, [iframeSrc, mode]);

  useEffect(() => {
    if (mode !== 'iframe') return;

    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();

    function finishWithApi(api) {
      if (cancelled) return;
      setStatus('ready');

      // 尽力强制打开 UI（不同版本 API 可能不全，失败就忽略）
      safeCall(api, 'setShowToolBar', !!showToolBar);
      safeCall(api, 'setShowMenuBar', !!showMenuBar);
      safeCall(api, 'setShowAlgebraInput', !!showAlgebraInput);

      onApiReadyRef.current?.(api);
    }

    function poll() {
      const iframe = iframeRef.current;
      const win = iframe?.contentWindow;
      // 同域时可访问；否则会抛异常
      let api = null;
      try {
        api = win?.ggbApplet || null;
        if (!api && containerId) {
          // 有些构建会把 applet 挂到 window[id]
          api = win?.[containerId] || null;
        }
      } catch {
        api = null;
      }

      if (api && typeof api.evalCommand === 'function') {
        finishWithApi(api);
        return;
      }

      if (Date.now() - startedAt > 15000) {
        if (cancelled) return;
        setStatus('error');
        onErrorRef.current?.(new Error('GeoGebra iframe 加载超时（15s），请检查静态资源是否完整/是否被浏览器拦截）'));
        return;
      }

      timer = window.setTimeout(poll, 200);
    }

    setStatus('loading');

    // 先等 iframe 挂载后再轮询（也兼容缓存极快的情况）
    timer = window.setTimeout(poll, 0);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [
    mode,
    containerId,
    showToolBar,
    showMenuBar,
    showAlgebraInput
  ]);

  // ------------------------
  // deploy 模式（轻量注入）
  // ------------------------
  useEffect(() => {
    if (mode !== 'deploy') return;

    let cancelled = false;

    async function boot() {
      try {
        setStatus('loading');
        await loadScriptOnce('/geogebra/deployggb.js');
        if (cancelled) return;

        if (!window.GGBApplet) {
          throw new Error('GeoGebra 脚本已加载，但未发现 GGBApplet');
        }

        // 等一帧，确保容器已经完成布局（能拿到正确 clientWidth/clientHeight）
        await new Promise((r) => requestAnimationFrame(() => r()));
        if (cancelled) return;

        const parameters = {
          id: containerId,
          appName,
          width: typeof width === 'number' ? width : undefined,
          height: typeof height === 'number' ? height : undefined,
          showToolBar,
          showMenuBar,
          showAlgebraInput,
          allowStyleBar,
          enableLabelDrags,
          enableShiftDragZoom,
          enableRightClick,
          showResetIcon,
          showLogging: true,
          appletOnLoad: (api) => {
            if (cancelled) return;
            setStatus('ready');
            onApiReadyRef.current?.(api);
          },
          onError: () => {
            if (cancelled) return;
            setStatus('error');
            onErrorRef.current?.(new Error('GeoGebra applet 加载失败'));
          }
        };

        const applet = new window.GGBApplet(parameters, '5.0');
        // 强制使用自托管 codebase
        applet.setHTML5Codebase(codebase, true);
        appletRef.current = applet;

        // `inject(containerId, noPreview)`
        applet.inject(containerId, true);
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        onErrorRef.current?.(e);
      }
    }

    boot();

    return () => {
      cancelled = true;
      try {
        const container = document.getElementById(containerId);
        if (container && appletRef.current) {
          appletRef.current.removeExistingApplet(container, false);
          container.innerHTML = '';
        }
      } catch {
        // ignore
      }
      appletRef.current = null;
    };
  }, [
    mode,
    containerId,
    appName,
    width,
    height,
    codebase,
    showToolBar,
    showMenuBar,
    showAlgebraInput,
    allowStyleBar,
    enableLabelDrags,
    enableShiftDragZoom,
    enableRightClick,
    showResetIcon
  ]);

  // ------------------------
  // Debug snapshot（可选）
  // ------------------------
  useEffect(() => {
    if (!debug) return;

    try {
      if (mode === 'deploy') {
        const el = document.getElementById(containerId);
        if (!el) return;
        const article = el.querySelector('.appletParameters');
        const attrs = {};
        if (article) {
          for (const a of Array.from(article.attributes || [])) {
            if (a?.name?.startsWith('data-param-')) {
              attrs[a.name] = a.value;
            }
          }
        }

        setDebugSnapshot({
          mode,
          status,
          containerId,
          containerSize: { w: el.clientWidth, h: el.clientHeight },
          codebase,
          appName,
          hasAppletParameters: !!article,
          dataParams: {
            showToolBar: attrs['data-param-showToolBar'],
            showMenuBar: attrs['data-param-showMenuBar'],
            showAlgebraInput: attrs['data-param-showAlgebraInput']
          }
        });
      } else {
        const iframe = iframeRef.current;
        setDebugSnapshot({
          mode,
          status,
          iframeSrc: computedIframeSrc,
          iframeLoaded: !!iframe?.contentWindow,
          hasGgbApplet: (() => {
            try {
              return !!iframe?.contentWindow?.ggbApplet;
            } catch {
              return false;
            }
          })()
        });
      }
    } catch {
      // ignore
    }
  }, [debug, mode, status, containerId, codebase, appName, computedIframeSrc]);

  return (
    <div style={{ width, height, position: 'relative' }}>
      {mode === 'iframe' ? (
        <iframe
          ref={iframeRef}
          title="GeoGebra"
          src={computedIframeSrc || undefined}
          style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        />
      ) : (
        <div id={containerId} style={{ width: '100%', height: '100%' }} />
      )}

      {debug ? (
        <div
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            zIndex: 9999,
            padding: 10,
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.18)',
            background: 'rgba(0,0,0,0.45)',
            color: 'rgba(255,255,255,0.9)',
            fontSize: 12,
            lineHeight: 1.3,
            maxWidth: 620,
            pointerEvents: 'none'
          }}
        >
          <div style={{ fontWeight: 650, marginBottom: 6 }}>GeoGebra Debug</div>
          <div>mode: {debugSnapshot?.mode || mode}</div>
          <div>status: {debugSnapshot?.status || status}</div>
          {mode === 'deploy' ? (
            <>
              <div>container: {containerId}</div>
              <div>
                size: {debugSnapshot?.containerSize?.w ?? '-'} x {debugSnapshot?.containerSize?.h ?? '-'}
              </div>
              <div>appName: {appName}</div>
              <div>codebase: {codebase}</div>
              <div>has .appletParameters: {String(!!debugSnapshot?.hasAppletParameters)}</div>
              <div>
                data-param-showToolBar / showMenuBar / showAlgebraInput:{' '}
                {debugSnapshot?.dataParams?.showToolBar ?? '-'} / {debugSnapshot?.dataParams?.showMenuBar ?? '-'} /{' '}
                {debugSnapshot?.dataParams?.showAlgebraInput ?? '-'}
              </div>
            </>
          ) : (
            <>
              <div>iframe: {debugSnapshot?.iframeSrc || computedIframeSrc}</div>
              <div>iframeLoaded: {String(!!debugSnapshot?.iframeLoaded)}</div>
              <div>has ggbApplet: {String(!!debugSnapshot?.hasGgbApplet)}</div>
            </>
          )}
        </div>
      ) : null}

      {status !== 'ready' ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.15)',
            color: 'rgba(255,255,255,0.85)',
            pointerEvents: 'none'
          }}
        >
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.12)'
            }}
          >
            {status === 'loading' && '正在加载 GeoGebra…'}
            {status === 'error' && 'GeoGebra 加载失败/超时（请检查 public/geogebra/ 资源路径）'}
            {status === 'init' && '初始化中…'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
