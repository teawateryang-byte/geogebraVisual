import { useCallback, useMemo, useRef, useState } from 'react';
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

  const readyBadge = useMemo(() => (ggbApi ? 'GeoGebra 已就绪' : 'GeoGebra 未就绪'), [ggbApi]);

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
      setError('请输入你的自然语言描述，例如："画一个椭圆"');
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
        signal: controller.signal
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `AI 服务错误（HTTP ${res.status}）`);
      }

      const cmds = normalizeCommands(data.commands);
      setExplanation(data.explanation || '');
      setLastCommands(cmds);

      executeCommands(cmds);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, [executeCommands, text]);

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
          width="100%"
          height="100%"
          codebase="/geogebra/HTML5/5.0/web/"
          appName="classic"
          showToolBar={false}
          showMenuBar={false}
          showAlgebraInput={false}
          onApiReady={(api) => {
            setGgbApi(api);
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

      <div className="floatingPanel" role="dialog" aria-label="AI 绘图对话框">
        <div className="panelHeader">
          <div className="title">自然语言绘图（GeoGebra + AI）</div>
          <div className="badge">{readyBadge}</div>
        </div>

        <div className="panelBody">
          <div className="small">输入示例：画一个椭圆 / 圆上做一个点并沿圆周运动 / 画抛物线并用滑块控制开口大小</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='例如："画一个椭圆"'
          />

          <div className="row">
            <button onClick={onClear} disabled={!ggbApi || loading}>清空</button>
            <button className="primary" onClick={onSubmit} disabled={loading}>
              {loading ? '生成中…' : '提交给 AI'}
            </button>
          </div>

          {error ? <div className="error">{error}</div> : null}

          {explanation ? (
            <div className="output" aria-label="AI 解释">
              {explanation}
            </div>
          ) : null}

          {lastCommands?.length ? (
            <div className="commands" aria-label="GeoGebra 命令">
              {lastCommands.join('\n')}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
