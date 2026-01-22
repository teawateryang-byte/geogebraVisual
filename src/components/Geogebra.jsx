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

/**
 * GeoGebra Applet React 组件
 * - 挂载：加载 `deployggb.js` 并注入 applet
 * - 卸载：移除 applet DOM（尽力清理）
 * - 通过 `onApiReady(api)` 把 GeoGebra JS API 实例交给父组件
 */
export default function Geogebra({
  width = '100%',
  height = '100%',
  codebase = '/geogebra/HTML5/5.0/web/',
  appName = 'classic',
  showToolBar = false,
  showMenuBar = false,
  showAlgebraInput = false,
  allowStyleBar = true,
  enableLabelDrags = true,
  enableShiftDragZoom = true,
  enableRightClick = true,
  showResetIcon = true,
  onApiReady,
  onError
}) {
  const [status, setStatus] = useState('init'); // init | loading | ready | error
  const containerId = useMemo(
    () => `ggb-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    []
  );
  const appletRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        setStatus('loading');
        await loadScriptOnce('/geogebra/deployggb.js');
        if (cancelled) return;

        if (!window.GGBApplet) {
          throw new Error('GeoGebra 脚本已加载，但未发现 GGBApplet');
        }

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
            onApiReady?.(api);
          },
          onError: () => {
            if (cancelled) return;
            setStatus('error');
            onError?.(new Error('GeoGebra applet 加载失败'));
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
        onError?.(e);
      }
    }

    boot();

    return () => {
      cancelled = true;
      try {
        const container = document.getElementById(containerId);
        if (container && appletRef.current) {
          // deployggb.js 内部会尝试调用 window[parameters.id].remove()
          appletRef.current.removeExistingApplet(container, false);
          container.innerHTML = '';
        }
      } catch {
        // ignore
      }
      appletRef.current = null;
    };
    // 只有首次挂载时注入；如需动态重建，可改为依赖 props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width, height, position: 'relative' }}>
      <div id={containerId} style={{ width: '100%', height: '100%' }} />
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
          <div style={{ padding: 12, borderRadius: 12, background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}>
            {status === 'loading' && '正在加载 GeoGebra…'}
            {status === 'error' && 'GeoGebra 加载失败（请检查 public/geogebra/ 资源路径）'}
            {status === 'init' && '初始化中…'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
