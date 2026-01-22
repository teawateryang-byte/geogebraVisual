const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3002;

const SYSTEM_PROMPT = `你是一个几何学助手，可以通过GeoGebra绘制几何图形和动画。

当用户请求绘制图形或动画时，请提供：
1. 友好的解释，包括数学概念和原理
2. 清晰的GeoGebra命令

规范：
1. 将GeoGebra命令放在\`\`\`geogebra和\`\`\`标记之间，每行一个命令。
2. 不要在GeoGebra代码块中添加注释。
3. 命令应该按照逻辑顺序排列，从基本元素到复杂构造。
4. 数学公式应该包裹在$$中

GeoGebra支持的命令类型包括：

## 基本元素
- 点：A = (2, 3)
- 向量：v = Vector[A, B] 或 v = (1, 2)
- 线段：Segment(A, B)
- 直线：Line(A, B)
- 射线：Ray(A, B)
- 圆：Circle(A, 3) 或 Circle(A, B)
- 椭圆：Ellipse(F1, F2, a)
- 多边形：Polygon(A, B, C, …)
- 正多边形：RegularPolygon(A, B, n)

## 函数和曲线
- 斜率：Slope(line)

## 动画和交互
- 滑块：a = Slider[0, 10, 0.1]
- 启动/停止动画：StartAnimation[a, true] 或 StartAnimation[a, false]
- 设置动画速度：SetAnimationSpeed(object, speed)
- 条件显示对象：SetConditionToShowObject(object, condition)
- 设置轨迹：SetTrace(object, true) 或 SetTrace(object, false)
- 轨迹曲线：Locus(point, parameter)

## 高级功能
- 序列：Sequence(expression, variable, from, to, step)
- 列表：{a, b, c}
- 条件表达式：If(condition, then, else)
- 文本对象：Text("文本", (x, y))
- 脚本按钮（示意）：点击脚本中使用 RunClickScript("命令")

## 动画示例

### 1. 创建滑块并用于动画：
  a = Slider[0, 10, 0.1]
  P = (a, 0)
  StartAnimation[a, true]

### 2. 圆上运动的点：
  a = Slider[0, 2π, 0.01]
  P = (5 cos(a), 5 sin(a))
  Circle((0, 0), 5)
  StartAnimation[a, true]

### 3. 函数图像的动态变化：
  a = Slider[0, 5, 0.1]
  f(x) = a x^2
  StartAnimation[a, true]

请确保命令语法正确，并在解释中提及每个命令的目的。
如果用户的请求不明确，请提出澄清问题。
用户的请求可能与之前提出的请求相关。

多轮对话（重要）：
- 你会收到历史对话消息（用户与助手的内容），请把它当作同一张 GeoGebra 构造的延续。
- 当用户说“在上一次基础上/继续/再加/修改”时，优先复用已有对象名称与参数，不要无故重命名；**不要重复输出未变化的旧命令**，只输出新增命令或确实需要修改的命令（重复定义可能导致重名冲突/执行失败）。

- 如果必须引用之前对象，请沿用历史里出现的对象名（如 O, A, B, a 等）。

兼容性约束（重要）：

- 除非用户明确要求“脚本按钮/点击脚本/更新脚本/自动脚本”，否则不要输出 RunClickScript / RunUpdateScript / SetClickScript / SetUpdateScript / Execute / Button 等脚本相关命令。

- 需要动画时，优先使用 Slider + StartAnimation + SetAnimationSpeed/SetTrace/Locus 等标准命令实现，不要用脚本替代。`;




function sanitizeCommands(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => String(l || '').trim())
    .filter(Boolean)
    // 基础注释过滤（按你的规范：代码块内不应有注释）
    .filter((l) => !/^\/\//.test(l))
    .filter((l) => !/^#/.test(l))
    .filter((l) => !/^\/\*/.test(l))
    .filter((l) => !/^\*\//.test(l))
    // 兼容性过滤：GeoGebra HTML5 有时脚本模块未加载就执行会报错（Class$S381）
    // 除非用户明确要求脚本按钮，否则避免把这类“脚本命令”下发给前端执行。
    .filter((l) => !/^RunClickScript\s*\(/i.test(l))
    .filter((l) => !/^RunUpdateScript\s*\(/i.test(l))
    .filter((l) => !/^SetClickScript\s*\(/i.test(l))
    .filter((l) => !/^SetUpdateScript\s*\(/i.test(l))
    .filter((l) => !/^Execute\s*\(/i.test(l))
    .filter((l) => !/^Button\s*\(/i.test(l));
}




function extractGeoGebraBlock(text) {
  if (!text) return { commands: [], explanation: '' };

  const s = String(text);
  // 兼容：```geogebra\n...``` / ```geogebra\r\n...```（结尾可能不带换行）
  const fence = /```\s*geogebra\s*\r?\n([\s\S]*?)```/i;
  const m = s.match(fence);

  const commands = m
    ? sanitizeCommands(
        m[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      )
    : [];

  // explanation：去掉代码块后剩余内容
  const explanation = m ? (s.replace(m[0], '').trim() || '') : s.trim();

  return { commands, explanation };
}


function ruleBasedFallback(userText) {
  const t = String(userText || '').trim();
  if (!t) {
    return {
      explanation: '你的输入为空，请描述你想绘制的图形或动画。',
      commands: []
    };
  }

  // 一个非常小的兜底：让项目在没有 Key 时也能跑通演示链路
  if (/椭圆/.test(t)) {
    return {
      explanation:
        '用标准椭圆方程 $$x^2/a^2 + y^2/b^2 = 1$$（这里取 a=5, b=3）来绘制椭圆。第一条命令直接定义隐式曲线；第二条命令添加文字标注。',
      commands: ['x^2/25 + y^2/9 = 1', 'Text("椭圆：x^2/25 + y^2/9 = 1", (-9, 6))']
    };
  }

  if (/圆/.test(t) && /运动|动画|转/.test(t)) {
    return {
      explanation:
        '用滑块 a 作为参数角度（从 0 到 $$2\\pi$$），点 P 按 (5 cos(a), 5 sin(a)) 在半径 5 的圆周上运动，然后启动滑块动画。',

      commands: ['a = Slider[0, 2π, 0.01]', 'Circle((0, 0), 5)', 'P = (5 cos(a), 5 sin(a))', 'StartAnimation[a, true]']
    };
  }

  if (/圆/.test(t)) {
    return {
      explanation: '先创建圆心 O，再以半径 5 绘制圆。',
      commands: ['O = (0, 0)', 'Circle(O, 5)']
    };
  }

  return {
    explanation:
      '当前服务未配置 LLM Key，已进入演示兜底模式。我暂时只能处理“圆/椭圆/圆周运动”等少量请求。请在后端配置 DEEPSEEK_API_KEY 后再试更复杂的自然语言绘图。',
    commands: []
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const allowed = new Set(['user', 'assistant']);

  // 控制上下文长度，避免 token 过大
  const MAX_MESSAGES = 8; // 最近 4 轮
  const MAX_CHARS_PER_MESSAGE = 4000;

  return history
    .filter((m) => m && allowed.has(m.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS_PER_MESSAGE) }))
    .filter((m) => m.content)
    .slice(-MAX_MESSAGES);
}

async function callDeepSeekChat({ userText, history }) {

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  if (!apiKey) {
    return { mode: 'fallback', ...ruleBasedFallback(userText), raw: null };
  }

  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

  const resp = await axios.post(
    url,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...normalizeHistory(history),
        { role: 'user', content: userText }
      ],

      temperature: 0.2
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60_000
    }
  );

  const content = resp?.data?.choices?.[0]?.message?.content;
  const { commands, explanation } = extractGeoGebraBlock(content);

  return {
    mode: 'llm',
    explanation,
    commands,
    raw: content
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/translate', async (req, res) => {
  try {
    const text = req?.body?.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text 不能为空' });
    }

    const history = req?.body?.history;
    const result = await callDeepSeekChat({ userText: text.trim(), history });


    // 最终防线：无论 LLM 返回什么，后端在响应前再做一次命令清洗，避免前端执行到不兼容命令。
    const safeCommands = sanitizeCommands(result.commands || []);

    if (!safeCommands || safeCommands.length === 0) {

      // 兼容 prompt 的“澄清提问”路径：允许只返回解释（不强行当成错误）。
      return res.json({
        explanation:
          result.explanation ||
          '我需要你补充一些关键信息（例如对象名称、位置/坐标、参数范围、是否需要动画），然后我才能给出可执行的 GeoGebra 命令。',
        commands: [],
        needClarification: true,
        raw: process.env.RETURN_RAW === 'true' ? result.raw : undefined,
        mode: result.mode
      });
    }

    return res.json({
      explanation: result.explanation || '',
      commands: safeCommands,
      needClarification: false,
      raw: process.env.RETURN_RAW === 'true' ? result.raw : undefined,
      mode: result.mode
    });


  } catch (e) {
    const message = e?.response?.data ? JSON.stringify(e.response.data) : e?.message || 'AI 服务异常';
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
