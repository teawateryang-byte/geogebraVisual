import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import Geogebra from './components/Geogebra.jsx';



function normalizeCommands(commands) {
  if (!commands) return [];
  if (Array.isArray(commands)) return commands.map(String).map((s) => s.trim()).filter(Boolean);
  return String(commands)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function App() {
  const [ggbApi, setGgbApi] = useState(null);
  const [text, setText] = useState('画一个椭圆：中心在原点，长轴 10，短轴 6');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [explanation, setExplanation] = useState('');
  const [lastCommands, setLastCommands] = useState([]);
  const abortRef = useRef(null);

  // 多轮对话：保留最近若干条 user/assistant 消息作为上下文发给后端
  const HISTORY_KEEP_MESSAGES = 12; // 本地最多保留 6 轮
  const HISTORY_SEND_MESSAGES = 8; // 每次请求带最近 4 轮，避免 token 过大
  const [chatHistory, setChatHistory] = useState([]); // { role: 'user'|'assistant', content: string }[]


  // AI 对话框：固定尺寸 + 可拖动位置（px）
  const PANEL_W = 330;
  const PANEL_H = 630;
  const PANEL_MARGIN = 18;

  const clampPanelPos = useCallback(
    (pos) => {
      if (typeof window === 'undefined') return pos;
      const maxX = Math.max(PANEL_MARGIN, window.innerWidth - PANEL_MARGIN - PANEL_W);
      const maxY = Math.max(PANEL_MARGIN, window.innerHeight - PANEL_MARGIN - PANEL_H);
      return {
        x: Math.min(Math.max(PANEL_MARGIN, pos.x), maxX),
        y: Math.min(Math.max(PANEL_MARGIN, pos.y), maxY)
      };
    },
    [PANEL_H, PANEL_MARGIN, PANEL_W]
  );

  const [panelPos, setPanelPos] = useState(() => ({ x: PANEL_MARGIN, y: PANEL_MARGIN }));
  const [panelDragging, setPanelDragging] = useState(false);
  const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  useEffect(() => {
    // 初始位置放右下角；如果用户后续拖动，会被拖动逻辑覆盖。
    if (typeof window === 'undefined') return;
    setPanelPos(
      clampPanelPos({
        x: window.innerWidth - PANEL_MARGIN - PANEL_W,
        y: window.innerHeight - PANEL_MARGIN - PANEL_H
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setPanelPos((p) => clampPanelPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPanelPos]);

  const onPanelHeaderPointerDown = useCallback(
    (e) => {
      // 仅响应主键；同时兼容触摸
      if (e.button !== undefined && e.button !== 0) return;
      if (e.pointerType === 'mouse' && (e.ctrlKey || e.metaKey || e.altKey)) {
        // 避免某些快捷键拖拽误触
      }

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;

      dragRef.current = {
        active: true,
        startX,
        startY,
        originX: panelPos.x,
        originY: panelPos.y
      };
      setPanelDragging(true);

      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    },
    [panelPos.x, panelPos.y]
  );

  const onPanelHeaderPointerMove = useCallback(
    (e) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const next = clampPanelPos({ x: dragRef.current.originX + dx, y: dragRef.current.originY + dy });
      setPanelPos(next);
    },
    [clampPanelPos]
  );

  const onPanelHeaderPointerUp = useCallback(() => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setPanelDragging(false);
  }, []);

  const readyBadge = useMemo(() => (ggbApi ? 'GeoGebra 已就绪' : 'GeoGebra 未就绪'), [ggbApi]);


  const debugEnabled = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).has('ggbDebug');
    } catch {
      return false;
    }
  }, []);

  const executeCommands = useCallback(
    (commands) => {
      const cmds = normalizeCommands(commands);
      if (!ggbApi) {
        throw new Error('GeoGebra 尚未就绪，请稍等 applet 加载完成');
      }
      if (cmds.length === 0) {
        throw new Error('没有可执行的 GeoGebra 命令');
      }

      // 尽量按顺序执行；一旦失败就中止并抛错
      for (const cmd of cmds) {
        const ok = ggbApi.evalCommand(cmd);
        if (!ok) {
          throw new Error(`命令执行失败：${cmd}`);
        }
      }

      setLastCommands(cmds);
    },
    [ggbApi]
  );

  const onSubmit = useCallback(async () => {
    setError('');
    setExplanation('');

    const trimmed = text.trim();
    if (!trimmed) {
      setError('请输入你的自然语言描述，例如:"画一个椭圆"');
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const historyToSend = chatHistory.slice(-HISTORY_SEND_MESSAGES);
      const res = await fetch('http://localhost:3002/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, history: historyToSend }),
        signal: controller.signal
      });


      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `AI 服务错误（HTTP ${res.status}）`);
      }

      const cmds = normalizeCommands(data.commands);
      setExplanation(data.explanation || '');
      setLastCommands(cmds);

      // 把本轮对话记入历史，供下一轮续写（assistant 内容包含解释 + geogebra 命令块）
      const assistantMd = `${String(data.explanation || '').trim()}${cmds.length ? `\n\n\`\`\`geogebra\n${cmds.join('\n')}\n\`\`\`` : ''}`.trim();
      setChatHistory((prev) => {
        const next = [
          ...prev,
          { role: 'user', content: trimmed },
          ...(assistantMd ? [{ role: 'assistant', content: assistantMd }] : [])
        ];
        return next.slice(-HISTORY_KEEP_MESSAGES);
      });

      // 允许 AI 先提出澄清问题（此时可能没有可执行命令）

      if (cmds.length > 0) {
        executeCommands(cmds);
      } else if (data?.needClarification) {
        setError('请根据上方解释补充信息后再提交。');
      }

    } catch (e) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, [executeCommands, text, chatHistory, HISTORY_KEEP_MESSAGES, HISTORY_SEND_MESSAGES]);


  const onClear = useCallback(() => {
    setError('');
    setExplanation('');
    setLastCommands([]);
    if (!ggbApi) return;
    try {
      // reset 会清空当前构造
      ggbApi.reset();
    } catch {
      // ignore
    }
  }, [ggbApi]);

  return (
    <div className="appRoot">
      <div className="ggbStage">
        <Geogebra
          mode="iframe"
          width="100%"
          height="100%"
          appName="classic"
          showToolBar={true}
          showMenuBar={true}
          showAlgebraInput={true}
          debug={debugEnabled}
          onApiReady={(api) => {
            setGgbApi(api);
            // 尽力确保 UI 打开（不同版本 API 可能不全）
            try {
              api?.setShowToolBar?.(true);
              api?.setShowMenuBar?.(true);
              api?.setShowAlgebraInput?.(true);
            } catch {
              // ignore
            }
            // 初始给个干净视图
            try {
              api.setCoordSystem(-10, 10, -7.5, 7.5);
            } catch {
              // ignore
            }
          }}
          onError={(e) => setError(e?.message || 'GeoGebra 加载失败')}
        />
      </div>

      <div
        className={`floatingPanel${panelDragging ? ' dragging' : ''}`}
        role="dialog"
        aria-label="AI 绘图对话框"
        style={{ left: panelPos.x, top: panelPos.y, width: PANEL_W, height: PANEL_H }}
      >
        <div
          className="panelHeader"
          onPointerDown={onPanelHeaderPointerDown}
          onPointerMove={onPanelHeaderPointerMove}
          onPointerUp={onPanelHeaderPointerUp}
          onPointerCancel={onPanelHeaderPointerUp}
        >
          <div className="title">自然语言绘图（GeoGebra + AI）</div>
          <div className="badge">{readyBadge}</div>
        </div>


        <div className="panelBody">
          <div className="small">输入示例：画一个椭圆 / 圆上做一个点并沿圆周运动 / 画抛物线并用滑块控制开口大小</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='例如:"画一个椭圆"' />

          <div className="row">
            <button onClick={onClear} disabled={!ggbApi || loading}>
              清空
            </button>
            <button className="primary" onClick={onSubmit} disabled={loading}>
              {loading ? '生成中…' : '提交给 AI'}
            </button>
          </div>

          {error ? <div className="error">{error}</div> : null}

          {explanation ? (
            <div className="output markdown" aria-label="AI 解释">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {explanation}
              </ReactMarkdown>
            </div>
          ) : null}

          {lastCommands?.length ? (
            <pre className="commands" aria-label="GeoGebra 命令">
              <code>{lastCommands.join('\n')}</code>
            </pre>
          ) : null}

        </div>
      </div>
    </div>
  );
}
