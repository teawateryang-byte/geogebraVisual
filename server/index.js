const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

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

请确保命令语法正确，并在解释中提及每个命令的目的。
如果用户的请求不明确，请提出澄清问题。`;

function extractGeoGebraBlock(text) {
  if (!text) return { commands: [], explanation: '' };

  const s = String(text);
  // 兼容：```geogebra\n...```（结尾可能不带换行）
  const fence = /```\s*geogebra\s*\n([\s\S]*?)```/i;
  const m = s.match(fence);


  const commands = m
    ? m[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
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

async function callDeepSeekChat({ userText }) {
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

    const result = await callDeepSeekChat({ userText: text.trim() });

    if (!result.commands || result.commands.length === 0) {
      // 如果 LLM 没输出命令块，给出明确提示
      return res.status(422).json({
        error:
          'AI 返回中没有解析到 GeoGebra 命令块（需要用 ```geogebra ... ``` 包裹）。你可以更具体地描述：对象名称、位置、参数范围、是否需要动画等。',
        explanation: result.explanation || '',
        raw: result.raw || null
      });
    }

    return res.json({
      explanation: result.explanation || '',
      commands: result.commands,
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
