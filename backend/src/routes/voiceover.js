'use strict'

const fs            = require('fs')
const path          = require('path')
const os            = require('os')
const crypto        = require('crypto')
const { execFile }  = require('child_process')
const { promisify } = require('util')
const { jsonrepair } = require('jsonrepair')

const { UPLOAD_ROOT, localUploadPath, fetchMediaBuffer } = require('../lib/uploads')

const execFileAsync = promisify(execFile)
const UPLOAD_DIR    = UPLOAD_ROOT
const VIDEO_CACHE   = path.join(UPLOAD_ROOT, '.video-cache')

// 视频下载缓存：URL → 本地文件 + JSON 元数据（含精确时长）
function cacheKey(url) {
  return crypto.createHash('md5').update(url.split('?')[0]).digest('hex')
}

function getCacheInfo(url) {
  const key  = cacheKey(url)
  const meta = path.join(VIDEO_CACHE, `${key}.json`)
  if (!fs.existsSync(meta)) return null
  try {
    const info = JSON.parse(fs.readFileSync(meta, 'utf8'))
    if (!fs.existsSync(info.path)) return null
    return info
  } catch { return null }
}

async function downloadWithCache(url) {
  fs.mkdirSync(VIDEO_CACHE, { recursive: true })

  // 如果是本地 .video-cache URL，直接查找本地文件
  const cacheMatch = url.match(/\.video-cache\/([a-f0-9]+)\.mp4/)
  if (cacheMatch) {
    const dest = path.join(VIDEO_CACHE, `${cacheMatch[1]}.mp4`)
    const meta = path.join(VIDEO_CACHE, `${cacheMatch[1]}.json`)
    if (fs.existsSync(dest) && fs.existsSync(meta)) {
      return JSON.parse(fs.readFileSync(meta, 'utf8'))
    }
  }

  const existing = getCacheInfo(url)
  if (existing) return existing

  const key  = cacheKey(url)
  const dest = path.join(VIDEO_CACHE, `${key}.mp4`)

  const local = localUploadPath(url)
  if (local) {
    fs.copyFileSync(local, dest)
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  }

  const duration = await probeDuration(dest)
  const size     = fs.statSync(dest).size
  const info     = { url, path: dest, duration, size, cachedAt: Date.now() }
  fs.writeFileSync(path.join(VIDEO_CACHE, `${key}.json`), JSON.stringify(info))
  return info
}

const DEFAULT_API_URL   = 'https://api.deepseek.com'
const DEFAULT_MODEL     = 'deepseek-chat'

function estimateDuration(text) {
  const chars = (text || '').replace(/\s/g, '').length
  return Math.min(15, Math.max(4, Math.ceil(chars / 3.5)))
}

const SEEDANCE_QUALITY = '电影质感、4K 超高清、细节丰富、色彩自然、画面稳定、无抖动、无模糊无重影'
const CHAR_CONSISTENCY = '同一角色，服装一致，发型不变，保持人物样貌与服装一致'

function toSRTTime(sec) {
  const h  = Math.floor(sec / 3600)
  const m  = Math.floor((sec % 3600) / 60)
  const s  = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 1000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`
}

function chunkSubtitle(text, maxChars = 30) {
  const result = []
  let remaining = text.trim()
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) { result.push(remaining); break }
    let splitAt = -1
    for (let i = maxChars; i >= 1; i--) {
      if (/[。！？…，；、]/.test(remaining[i - 1])) { splitAt = i; break }
    }
    if (splitAt === -1) splitAt = Math.ceil(remaining.length / 2)
    result.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  return result
}

// 在标点符号处断句（完整句子不拆开）
function splitAtPunctuation(text) {
  const sentences = []
  let remaining = text.trim()
  while (remaining.length > 0) {
    const m = remaining.match(/^(.*?[。！？…；，、,;.!?]+)/)
    if (m) {
      sentences.push(m[1].trim())
      remaining = remaining.slice(m[1].length).trim()
    } else {
      sentences.push(remaining)
      break
    }
  }
  return sentences.filter(s => s.length > 0)
}

function buildSRT(videos, videoDurs) {
  const lines = []
  let idx = 1
  let offset = 0
  videos.forEach((v, i) => {
    const dur = videoDurs[i] || v.duration || 5
    const text = (v.subtitle || '').trim()
    if (text) {
      const chunks = chunkSubtitle(text)
      const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
      let chunkOffset = offset
      chunks.forEach(chunk => {
        const chunkDur = dur * (chunk.length / totalChars)
        const display = chunk.replace(/[。！？…；，、,;.!?：:]+$/, '')
        lines.push(`${idx++}`)
        lines.push(`${toSRTTime(chunkOffset)} --> ${toSRTTime(chunkOffset + chunkDur)}`)
        lines.push(display)
        lines.push('')
        chunkOffset += chunkDur
      })
    }
    offset += dur
  })
  return lines.join('\n')
}

async function probeDuration(filePath) {
  const r = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  return parseFloat(r.stdout.trim()) || 0
}

function escapeXml(str) {
  return (str || '').replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

async function generateVoiceoverShots(script, suggestedCount, style, ratio, mediaInfo = {}) {
  const apiKey  = process.env.STORYBOARD_API_KEY || ''
  const baseUrl = (process.env.STORYBOARD_API_URL || DEFAULT_API_URL).replace(/\/$/, '')
  const model   = process.env.STORYBOARD_MODEL   || DEFAULT_MODEL

  if (!apiKey) throw new Error('请配置 STORYBOARD_API_KEY 环境变量')

  const { imageCount = 0, videoCount = 0, audioCount = 0, subjectDefinitions = '', subtitleMode = 'on', subtitleInput = '' } = mediaInfo

  // subtitleInput provided → distribute exact text; empty → AI auto-generates narration
  const hasUserSubtitle = !!(subtitleInput && subtitleInput.trim())

  const systemMsg = `你是专业的视频导演和分镜脚本师，擅长把视频需求转化为可直接喂给 Seedance 2.0 视频模型的高质量分镜提示词。你精通 Seedance 2.0 的提示词优化公式和最佳实践。

【Seedance 2.0 提示词公式（核心）】
每段 prompt 结构分为必须项和可选项：

必须项（每段都要有）：
  精准主体 + 动作细节

可选项（根据需要添加，可提升画面质感）：
  场景环境 + 光影色调 + 镜头运镜 + 视觉风格 + 画质 + 约束条件

- 精准主体：用外貌特征定义人物（年龄/性别/发型/服装/体态），不使用人名。${imageCount + videoCount > 0 ? '如有参考素材，用「<图片 N>」格式锚定外貌，如"<图片 1>中的女性"。' : ''}
- 动作细节：描述具体身体部位的缓慢连续动作（手臂/头部/躯干/腿部分别怎么动），动作幅度要小、速度要慢——Seedance 擅长缓慢优雅的连续动作，不擅长快速/剧烈/多步骤动作。把情绪外化为可视动作（不说"感到忧虑"，改说"眉头微蹙，双手无意识地攥紧文件"）。
- 场景环境（可选）：具体的空间场景（不是抽象概念），包含道具、背景元素、空间纵深。
- 光影色调（可选）：一种光影氛围（柔光/侧光/逆光/金色暖光/冷白光等），全片保持统一基调。
- 镜头运镜（可选）：一种运镜方式（推入/拉出/环绕/横移/升降/固定），每段只用一种。
- 视觉风格（可选）：电影质感/纪录片风/广告风等。
- 画质（可选）：高清、4K、电影级画面等。
- 约束条件（可选）：末尾加上"无水印，无Logo"等约束。

【每段只做一件事（最重要）】
- Seedance 单段最适合「一个镜头一件事」：一段里只安排 ONE 个主体动作（如"缓慢转身"）或 ONE 个运镜（如"缓慢推镜"）——二选一为主，不要在一段里塞多种景别、多个动作。
- 动作要求：慢速、连续、小幅度。避免快速切换、跳跃、旋转等剧烈动作。好的动作示例："缓缓抬起右手翻开文件夹"、"微微侧头目光转向窗外"、"双手轻轻合拢放在桌面"。

【动作描写要点（Seedance 2.0 专项）】
- 拆解到身体部位：不写"她在思考"，改写"她右手食指轻触太阳穴，目光微微上移，嘴唇微张"
- 缓慢连续优先：所有动作默认慢速执行，用"缓缓""轻轻""慢慢"修饰
- 情绪外化：把内心状态转化为外在动作/表情/肢体语言
- 单一动作链：一段只描述一个连贯动作序列（开始→过程→结束姿态），不跳切
- 避免的动作类型：奔跑、跳跃、快速转身、打斗、舞蹈、复杂手势

${hasUserSubtitle ? `【台词归组与分段（字幕层，严禁修改原文）】
1. 按视觉场景智能归组台词——同一地点/情绪/论点的多句台词归入同一分镜，subtitle 可含多句；但该段 prompt 只表现这组台词的「一个核心动作瞬间」。
2. ⚠️ 所有分镜 subtitle 拼接后必须逐字逐句100%等于用户提供的视频字幕原文。严禁改写、概括、增删任何字词标点。
3. 尽量让每个分镜多承载字幕内容（单个分镜最多约 15 秒 ≈ ~52个中文字），减少分镜总数。只有在视觉场景需要切换时才拆分新镜头，不要因为字幕稍长就拆分。
4. 禁止把单句话拆成多个分镜。
5. 只允许在句子边界（句号、问号、感叹号、省略号）处断开，不得在句子中间切割。` : `【字幕自动生成（重要）】
1. 用户未提供视频字幕，你必须根据视频需求自动生成合适的旁白/解说词，填入每个分镜的 subtitle 字段。
2. 生成的字幕要贴合视频需求的主题和内容，语言自然流畅，适合作为画外音旁白。
3. 每个分镜都必须有 subtitle（不允许留空），每段字幕约 15-50 个中文字。
4. 全部分镜的字幕拼接后应构成一段完整、连贯的解说/旁白。`}

【每格都要有一个具体的故事场景（重要）】
- 每个分镜都是一个具体的故事画面：有明确的地点、人物和正在发生的情境/动作，把台词的含义"演"成一个生活片段或故事瞬间，而不是抽象说教。
- 把抽象概念落成生活情景。例：把"社保不够"演成"老人对着一叠账单发愁"；把"及早规划"演成"年轻夫妻在台灯下一起记账"；把"复利增长"演成"小树苗长成大树/存钱罐一天天变满"。
- 全片场景要有跨度：不同地点、场合、时间、人物关系交替（家庭客厅 / 职场 / 户外 / 医院 / 银行 / 街道等）。
- 主角不必每格都居中出现，可让场景里的人物与情境来承接旁白。

【段与段衔接】
- 动作衔接：本段结尾动作与下段开头动作在逻辑上要能接上。
- 景别节奏：相邻段用景别变化带节奏，如 全景→中景→特写；避免连续两段同一景别。
- 运镜衔接：避免连续两段同向运镜；之间插一段固定镜头或反向运镜。

【镜头运动库（camera_movement 字段值，并在 prompt 中用中文写出）】
- 推入 Push-in：缓慢推近主体，强调情绪或细节
- 拉出揭示 Pull-back Reveal：拉远交代环境全貌
- 环绕 Orbit：绕主体旋转展示
- 固定 Static：稳定构图不动，专注内容
- 跟随横移 Track：平滑跟随移动
- 升降 Crane/Rise：垂直升降展示规模感
- 摇镜 Pan：水平转动拍摄场景
- 俯拍下移 Top-down：从上方俯瞰向下拍摄

【光影色调库（在 prompt 中点明一个，全片基调统一）】
- 柔和自然光：均匀柔光、浅景深——专业信任感
- 暖色侧光/金色光：温馨氛围——家庭/传承主题
- 冷白主光：高端冷静——商务/理财主题
- 明亮通透光：自然光、通透——日常生活场景
- 轮廓逆光：主体轮廓光、深色背景——人物强调

【首镜钩子（仅 shot_number=1）】
第一个分镜承担「留住观众」职责：用一个引发好奇或共鸣的动作/构图作为钩子，专业克制不浮夸。
${imageCount + videoCount > 0 || subjectDefinitions.trim() ? `
【素材引用规则（重要）】
如果用户提供了参考素材，必须在 prompt 中使用"<素材类型 N>"格式引用：
- 「<图片 1>」指代 content 数组中第1个 type="image_url" 的参考图片
- 「<图片 2>」指代第2个参考图片，以此类推
- 「<视频 1>」指代第1个参考视频
- 引用格式示例："<图片 1>中的短发女性缓缓转过身来，面带微笑..."
- 每个分镜都应引用素材来锚定人物外貌，防止 ID 漂移（换脸/变装）

【prompt 写法范例（参考格式，不要直接照搬内容）】
- 开头声明素材角色："<图片 1>中的红衣女子作为主角，<图片 2>作为场景参考"
- 每段锚定主体："女孩<图片 1>缓缓转头望向窗外，右手轻放在桌面..."
- 如有台词用花括号标注：角色说{台词内容}
- 结尾加全局约束："全程画面高清电影质感，色调统一，人物面部稳定不变形，动作自然流畅"
` : ''}
【防止常见问题】
${imageCount + videoCount > 0 ? '- 防 ID 漂移：每段都重复引用参考素材「<图片 N>」来锚定人物外貌\n' : ''}- 防水印：每段末尾必须加"无水印，无Logo"
- 防风格漂移：全片使用统一的光影色调描述词
- 防双胞胎问题：同一场景如有多人，用具体外貌特征区分（不要只写"两个人"）
- 防动作失真：避免高速/复杂动作，动作幅度小、速度慢
${imageCount + videoCount === 0 && !subjectDefinitions.trim() ? '- 禁止出现「<图片 N>」「<视频 N>」等素材引用标记（本次无参考素材）\n' : ''}

【风格锚点（写进 character_anchor 字段，勿在各段 prompt 重复）】
在 character_anchor 定义全片统一视觉锚点：主角形象（年龄/性别/发型/服装/体态）+ 视觉风格（电影质感/纪录片风/广告风等）+ 画质词（高清、4K、电影级画面）+ 主导光影色调。
⚠️ character_anchor 只锁「人物外貌 + 画风 + 色调 + 画质」，绝不写固定地点或场景。

【时长估算（后续会被 TTS 实际时长覆盖）】
- 中文TTS约每秒3.5字，时长 = ceil(字数/3.5)，最少4秒，最多15秒

【重要：JSON转义规则】
- 所有字段值中的英文双引号 " 必须转义为 \\"
- 不得使用任何 markdown 代码块标记
- 只输出一个纯 JSON 对象，不包含任何其他文字

【输出格式】
严格输出纯JSON对象（非数组），包含：
- character_anchor: 全片视觉锚点（中文，80-120字）：主角外貌描述（年龄/性别/发型/服装/体态）+ 视觉风格 + 画质词（高清、电影级画面）+ 主导光影色调（不要写固定地点/场景）
- shots: 分镜数组，每个元素包含：
  - shot_number: 编号（从1开始）
  - title: 分镜标题（中文，8字以内）
  - subtitle: ${hasUserSubtitle ? '该分镜对应的视频字幕原文（可多句，必须是原文精确子串，严禁修改、重写或概括）' : '根据视频需求自动生成的旁白/解说词（15-50字，不可留空）'}
  - description: 本格的具体故事场景（中文，30字以内：地点+人物+正在发生的情境/动作）
  - prompt: Seedance 2.0 视频提示词（中文，60-120字）。必须包含：精准主体 + 动作细节。可选添加：场景环境、光影色调、运镜方式、视觉风格、画质、约束条件。${imageCount + videoCount > 0 || subjectDefinitions.trim() ? '如有素材引用则用「<图片 N>中的...」格式开头。' : ''}${subjectDefinitions.trim() ? '如有已定义主体，prompt 中必须使用已定义的主体标签。' : ''}
  - duration: 预估时长（秒，整数，ceil(subtitle字数/3.5)，范围4-15）
  - ratio: 画面比例（使用用户指定比例）
  - camera_movement: 镜头运动（从镜头运动库中选择，中文标注）
  - mood: 情绪基调（中文）
  - subjects: 本分镜出场的主体标签数组（如 ["主体1", "主体2"]），从已定义的主体中选择本镜头需要出现的主体。如果没有定义主体则为空数组 []

只输出纯JSON对象，不包含任何其他文字或代码块标记。`

  let mediaHint = ''
  if (imageCount + videoCount + audioCount > 0) {
    const parts = []
    if (imageCount > 0) parts.push(`参考图片 ${imageCount} 张（引用方式：「图片 1」到「图片 ${imageCount}」）`)
    if (videoCount > 0) parts.push(`参考视频 ${videoCount} 条（引用方式：「视频 1」到「视频 ${videoCount}」）`)
    if (audioCount > 0) parts.push(`参考音频 ${audioCount} 条（引用方式：「音频 1」到「音频 ${audioCount}」）`)
    mediaHint = `\n- 用户提供了${parts.join('、')}，每个分镜 prompt 中必须使用「图片 n」格式引用对应素材，确保生成画面与参考素材一致`
  }

  let subjectHint = ''
  if (subjectDefinitions.trim()) {
    subjectHint = `\n\n【已定义的主体（必须严格遵守）】\n${subjectDefinitions.trim()}\n\n注意：在每段 prompt 中提到主体时，必须使用上面已定义的主体标签（如<主体1>@<图片 1>），确保主体一致性，避免省略绑定关系。`
  }

  let userMsgParts = []
  if (script && !subtitleInput) {
    userMsgParts.push(`口播文案：\n${script}`)
  } else if (script && subtitleInput) {
    userMsgParts.push(`视频需求：\n${script}`)
    userMsgParts.push(`视频字幕（必须完整拆分到各分镜的 subtitle 字段，不得遗漏或修改任何文字）：\n${subtitleInput}`)
  } else if (subtitleInput) {
    userMsgParts.push(`视频字幕（必须完整拆分到各分镜的 subtitle 字段，不得遗漏或修改任何文字）：\n${subtitleInput}`)
  }

  const userMsg = `${userMsgParts.join('\n\n')}

要求：
- 视觉风格：${style || '根据内容自动判断最合适的风格'}
- 画面比例：${ratio}
- 建议分镜数量：约 ${suggestedCount} 个（优先按视觉场景分组，可 ±2 调整）${mediaHint}${hasUserSubtitle ? '\n- 字幕文本必须100%完整覆盖到各分镜的subtitle字段中，每个分镜尽量多承载字幕（单个分镜最多约15秒≈52字），只有视觉场景需要切换时才拆分' : '\n- 每个分镜必须生成字幕（subtitle不可为空），参考视频需求内容自动生成合适的旁白/解说词'}

请严格按 Seedance 2.0 提示词公式生成每段 prompt：
1. 先定义 character_anchor（人物外貌+视觉风格+画质词+光影色调，不写地点）
2. 每段 prompt 必须包含：精准主体（外貌特征${imageCount > 0 || subjectDefinitions.trim() ? '，引用<图片 N>锚定' : ''}）+ 具体身体部位的缓慢动作。可选添加场景环境、光影色调、运镜等提升画面质感
3. 动作必须是缓慢连续的小幅度动作，拆解到身体部位描写
4. 相邻段在动作/景别/运镜上自然衔接
5. 首镜加一个克制的视觉钩子${imageCount > 0 || subjectDefinitions.trim() ? '\n6. 每段都要用「<图片 N>中的...」格式引用参考素材，防止人物 ID 漂移' : ''}${subjectHint}`

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      temperature: 0.75,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${errText.slice(0, 300)}`)
  }

  const data    = await res.json()
  const rawText = (data?.choices?.[0]?.message?.content || '').trim()
  if (!rawText) throw new Error('API 返回内容为空')

  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned))
    } catch {
      throw new Error('返回的 JSON 格式无效，请重试。原始：' + rawText.slice(0, 300))
    }
  }

  let rawShots, characterAnchor
  if (Array.isArray(parsed)) {
    rawShots = parsed
    characterAnchor = ''
  } else if (parsed && Array.isArray(parsed.shots)) {
    rawShots = parsed.shots
    characterAnchor = parsed.character_anchor || ''
  } else {
    throw new Error('返回格式无效：缺少 shots 数组')
  }

  // 强制保证：当用户提供了视频字幕时，分镜subtitle拼接必须严格等于原文
  if (hasUserSubtitle) {
    // 去掉所有空白后比较，确保内容完全一致
    const normalize = s => s.replace(/\s+/g, '')
    const combined = rawShots.map(s => normalize(s.subtitle || '')).join('')
    const original = normalize(subtitleInput)
    if (combined !== original) {
      // AI没有严格遵守，强制用原文按标点边界重新分配
      // 支持在所有中文标点处断开：句号、逗号、问号、感叹号、分号、冒号、省略号
      const segments = subtitleInput.match(/[^。！？…，；：\n]+[。！？…，；：\n]?/g) || [subtitleInput]
      const shotCount = rawShots.length
      const totalLen = subtitleInput.replace(/\s+/g, '').length
      const charsPerShot = Math.ceil(totalLen / shotCount)
      let chunks = []
      let current = ''
      for (const seg of segments) {
        if (current.replace(/\s+/g, '').length + seg.replace(/\s+/g, '').length > charsPerShot && current.trim().length > 0 && chunks.length < shotCount - 1) {
          chunks.push(current.trim())
          current = seg
        } else {
          current += seg
        }
      }
      if (current.trim()) chunks.push(current.trim())
      // 块数不足shots数时后面补空
      while (chunks.length < shotCount) chunks.push('')
      // 块数超过shots数时合并尾部
      while (chunks.length > shotCount) {
        const last = chunks.pop()
        chunks[chunks.length - 1] += last
      }
      // 强制覆盖每个shot的subtitle
      for (let i = 0; i < rawShots.length; i++) {
        rawShots[i].subtitle = chunks[i] || ''
      }
    }
  }

  return {
    characterAnchor,
    shots: rawShots.map(shot => {
      let prompt = String(shot.prompt || '').trim()
      const subtitleLen = (shot.subtitle || '').trim().length
      const minDuration = Math.max(4, Math.ceil(subtitleLen / 3.5))
      const duration = typeof shot.duration === 'number' && shot.duration >= minDuration && shot.duration <= 15
        ? shot.duration
        : Math.min(15, Math.max(4, minDuration))
      return {
        ...shot,
        prompt,
        duration,
      }
    }),
  }
}

async function analyzeSubjects(mediaList) {
  const geminiKey = process.env.GEMINI_API_KEY || ''
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

  if (!geminiKey) throw new Error('请配置 GEMINI_API_KEY 环境变量')

  const systemPrompt = `你是 Seedance 2.0 视频生成的主体定义助手。你的任务是分析用户提供的参考素材（图片/视频），识别其中的所有主体，并输出结构化的主体定义。

【主体定义规则】
1. 主体可以是：人物、动物、道具、场景元素等
2. 每个主体用 2-3 个清晰、稳定的静态特征描述（如服饰、发型、外观、类别），确保唯一可识别性
3. 定义格式：将<图片N>中的[主体核心特征]定义为<主体N>
4. 如果一张图片中有多个主体，分别定义每个
5. 特征描述要具体（不说"一个人"，要说"穿白衬衫、戴眼镜的中年男性"）
6. 避免使用可能变化的特征（如表情、姿势），优先用服饰、发型、体型等稳定特征

【输出格式】
严格输出纯JSON对象，包含：
- definitions: 数组，每个元素是一条主体定义字符串
- summary: 一句话概括（如"共识别3个主体：1位女性、1位男性、1只猫"）
- usage_hint: 简短的使用提示，说明后续 prompt 中如何引用这些主体

示例输出：
{
  "definitions": [
    "将<图片 1>中穿红色连衣裙、长卷发的年轻女性定义为<主体1>",
    "将<图片 1>中穿灰色西装、短发的中年男性定义为<主体2>",
    "将<图片 2>中白色毛发、蓝眼睛的布偶猫定义为<主体3>"
  ],
  "summary": "共识别3个主体：1位年轻女性、1位中年男性、1只布偶猫",
  "usage_hint": "在分镜 prompt 中使用 <主体1>@<图片 1> 格式引用，确保每次提及主体时都带上素材绑定关系"
}

只输出纯JSON对象，不包含任何其他文字或代码块标记。`

  // Build Gemini parts array - download images and send as inlineData (base64)
  const parts = [{ text: systemPrompt + '\n\n请分析以下参考素材中的所有主体，输出结构化的主体定义：\n' }]
  let imgIdx = 0
  for (const item of mediaList) {
    if (item.mediaType === 'image' && item.previewUrl) {
      imgIdx++
      parts.push({ text: `\n--- 图片 ${imgIdx} ---\n` })
      try {
        const imgRes = await fetch(item.previewUrl, { signal: AbortSignal.timeout(10_000) })
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
        const buffer = Buffer.from(await imgRes.arrayBuffer())
        const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
        parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } })
      } catch (e) {
        parts.push({ text: `[图片 ${imgIdx} 加载失败: ${e.message}]` })
      }
    }
  }

  if (imgIdx === 0) {
    throw new Error('没有可分析的图片素材（需要图片的预览URL）')
  }

  // Use OpenAI-compatible chat completions format (for third-party proxies like fidelityai)
  const geminiBaseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')
  const url = `${geminiBaseUrl}/v1/chat/completions`

  // Build OpenAI-compatible content array with image_url (base64 data URI)
  const userContent = [{ type: 'text', text: systemPrompt + '\n\n请分析以下参考素材中的所有主体，输出结构化的主体定义：' }]
  let idx2 = 0
  for (const p of parts) {
    if (p.text && p.text.startsWith('\n--- 图片')) {
      idx2++
      userContent.push({ type: 'text', text: `图片 ${idx2}：` })
    } else if (p.inlineData) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } })
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${geminiKey}` },
    body: JSON.stringify({
      model: geminiModel,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`)
  }

  const data = await res.json()
  const rawText = (data?.choices?.[0]?.message?.content || '').trim()
  if (!rawText) throw new Error('Gemini API 返回内容为空')

  const cleaned = rawText
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned))
    } catch {
      throw new Error('返回的 JSON 格式无效：' + rawText.slice(0, 200))
    }
  }

  return {
    definitions: parsed.definitions || [],
    summary: parsed.summary || '',
    usageHint: parsed.usage_hint || '',
  }
}

async function voiceoverRoutes(fastify) {

  fastify.post('/analyze-subjects', {
    schema: {
      body: {
        type: 'object', required: ['media'],
        properties: {
          media: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url:        { type: 'string' },
                mediaType:  { type: 'string' },
                previewUrl: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await analyzeSubjects(request.body.media || [])
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/generate-script', {
    schema: {
      body: {
        type: 'object',
        properties: {
          topic: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const apiKey  = process.env.STORYBOARD_API_KEY || ''
    const baseUrl = (process.env.STORYBOARD_API_URL || 'https://api.deepseek.com').replace(/\/$/, '')
    const model   = process.env.STORYBOARD_MODEL   || DEFAULT_MODEL
    if (!apiKey) return reply.code(500).send({ success: false, error: '请配置 STORYBOARD_API_KEY' })

    const topic = (request.body.topic || '').trim()
    const prompt = topic
      ? `你是一个短视频文案专家。请根据以下主题，生成一段适合AI视频生成的口播文案（100-200字）。要求：节奏紧凑、画面感强、适合配音朗读、适合拆分为多个分镜画面。直接输出文案，不要加标题或前缀。\n\n主题：${topic}`
      : '你是一个短视频文案专家。请随机选择一个有吸引力的话题，生成一段适合AI视频生成的口播文案（100-200字）。要求：节奏紧凑、画面感强、适合配音朗读、适合拆分为多个分镜画面。直接输出文案，不要加标题或前缀。'

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.9,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`AI API error ${res.status}: ${errText.slice(0, 200)}`)
      }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      return { success: true, data: { script: text } }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/init', {
    schema: {
      body: {
        type: 'object',
        properties: {
          script:    { type: 'string', maxLength: 5000 },
          style:     { type: 'string', maxLength: 200 },
          ratio:     { type: 'string' },
          shotCount: { type: 'integer', minimum: 2, maximum: 20 },
          imageCount: { type: 'integer', minimum: 0 },
          videoCount: { type: 'integer', minimum: 0 },
          audioCount: { type: 'integer', minimum: 0 },
          subjectDefinitions: { type: 'string', maxLength: 2000 },
          subtitleMode: { type: 'string', enum: ['on', 'off'] },
          subtitleInput: { type: 'string', maxLength: 5000 },
        },
      },
    },
  }, async (request, reply) => {
    const {
      script = '',
      style      = '',
      ratio      = '9:16',
      shotCount: overrideCount,
      imageCount = 0,
      videoCount = 0,
      audioCount = 0,
      subjectDefinitions = '',
      subtitleMode = 'on',
      subtitleInput = '',
    } = request.body

    if (!script.trim() && !subtitleInput.trim()) {
      return reply.code(400).send({ success: false, error: '视频需求和视频字幕不能全为空' })
    }

    try {
      const CPS = 3.5
      const primaryText = subtitleInput.trim() || script
      const scriptChars = primaryText.replace(/\s/g, '').length
      const estimatedDuration = scriptChars / CPS

      const AUTO_SHOT_MAX = 20
      const rawShotCount  = Math.round(estimatedDuration / 13)
      const autoShotCount = Math.max(2, Math.min(AUTO_SHOT_MAX, rawShotCount))
      const shotCount     = overrideCount ?? autoShotCount

      const { shots, characterAnchor } = await generateVoiceoverShots(
        script.trim() || `根据以下字幕内容生成对应的视频画面：${subtitleInput.trim()}`,
        shotCount, style, ratio,
        { imageCount, videoCount, audioCount, subjectDefinitions, subtitleMode, subtitleInput: subtitleInput.trim() }
      )

      // Duration based on each shot's subtitle length (always present)
      const shotsWithDuration = shots.map(shot => {
        const subtitleLen = (shot.subtitle || '').replace(/\s/g, '').length
        const minDuration = Math.max(4, Math.ceil(subtitleLen / 3.5))
        const duration = typeof shot.duration === 'number' && shot.duration >= minDuration && shot.duration <= 15
          ? shot.duration : Math.min(15, minDuration)
        return { ...shot, duration }
      })

      return {
        success: true,
        data: {
          autoShotCount,
          shotCount,
          characterAnchor,
          shots:              shotsWithDuration,
          totalVideoDuration: shotsWithDuration.reduce((a, s) => a + s.duration, 0),
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  // ── TTS: 生成整条语音，测量实际时长，按字数分配各分镜时长 ──────────────────
  fastify.post('/tts', {
    schema: {
      body: {
        type: 'object', required: ['script', 'shots'],
        properties: {
          script: { type: 'string', minLength: 1, maxLength: 5000 },
          voice:  { type: 'string' },
          shots: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['subtitle'],
              properties: { subtitle: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { script, voice = 'zh-CN-XiaoxiaoNeural', shots } = request.body

    const azureKey    = process.env.AZURE_SPEECH_KEY    || ''
    const azureRegion = process.env.AZURE_SPEECH_REGION || 'eastasia'

    if (!azureKey) return reply.code(500).send({ success: false, error: '请配置 AZURE_SPEECH_KEY 环境变量' })

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      const tokenRes = await fetch(
        `https://${azureRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
        { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': azureKey } }
      )
      if (!tokenRes.ok) throw new Error(`Azure TTS Token 获取失败：HTTP ${tokenRes.status}`)
      const token = await tokenRes.text()

      const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${voice}'>${escapeXml(script)}</voice></speak>`
      const ttsRes = await fetch(
        `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-48khz-96kbitrate-mono-mp3',
          },
          body: ssml,
          signal: AbortSignal.timeout(60_000),
        }
      )
      if (!ttsRes.ok) throw new Error(`TTS 合成失败：HTTP ${ttsRes.status}`)

      const audioName = `voiceover-tts-${Date.now()}.mp3`
      const audioPath = path.join(UPLOAD_DIR, audioName)
      fs.writeFileSync(audioPath, Buffer.from(await ttsRes.arrayBuffer()))

      const totalDuration = await probeDuration(audioPath)
      if (!totalDuration || totalDuration <= 0) throw new Error('无法读取语音时长')

      const charCounts = shots.map(s => (s.subtitle || '').replace(/\s/g, '').length)
      const totalChars = charCounts.reduce((a, b) => a + b, 0) || 1

      // 分配时长：保证 sum(shotDurations) >= totalDuration（视频不能比语音短）
      let shotDurations = charCounts.map(chars => {
        const raw = totalDuration * (chars / totalChars)
        return Math.max(4, Math.ceil(raw))
      })
      // 如果总和仍然小于音频时长（不太可能，因为 ceil 向上取整），补到最长的分镜
      let videoDurSum = shotDurations.reduce((a, b) => a + b, 0)
      if (videoDurSum < Math.ceil(totalDuration)) {
        const deficit = Math.ceil(totalDuration) - videoDurSum
        let maxIdx = 0
        shotDurations.forEach((d, i) => { if (d > shotDurations[maxIdx]) maxIdx = i })
        shotDurations[maxIdx] += deficit
      }

      const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')
      return {
        success: true,
        data: {
          audioUrl:      `${base}/uploads/${audioName}`,
          totalDuration,
          shotDurations,
          totalVideoDuration: shotDurations.reduce((a, b) => a + b, 0),
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  fastify.post('/merge', {
    schema: {
      body: {
        type: 'object', required: ['videos', 'audioUrl'],
        properties: {
          videos: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', required: ['url'],
              properties: {
                url:      { type: 'string' },
                subtitle: { type: 'string' },
                duration: { type: 'number' },
              },
            },
          },
          audioUrl: { type: 'string' },
          voice:    { type: 'string' },
          subtitle: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { videos, audioUrl, voice, subtitle: fullSubtitle } = request.body
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-merge-'))

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      // ── 1. 并行下载所有分镜视频（有缓存，不重复下载） ──────────────────────
      const downloadResults = await Promise.all(
        videos.map(async ({ url }, i) => {
          try {
            const info = await downloadWithCache(url)
            if (!info) return { path: null, duration: 0, index: i }
            return { path: info.path, duration: info.duration, index: i }
          } catch (e) {
            fastify.log.warn(`分镜 ${i + 1} 下载失败: ${e.message}`)
            return { path: null, duration: 0, index: i }
          }
        })
      )

      const succeeded = downloadResults.filter(r => r.path)
      if (succeeded.length < 1) {
        return reply.code(400).send({ success: false, error: '没有分镜视频下载成功，无法合并' })
      }
      const videoPaths = succeeded.map(r => r.path)
      const validVideos = succeeded.map(r => videos[r.index])

      // ── 2. 音频 & SRT ──────────────────────────────────────────────────────
      let audioPath
      const hasSubtitles = validVideos.some(v => v.subtitle && v.subtitle.trim())

      // 使用已有的整块音频（不重新 TTS）
      const localPath = localUploadPath(audioUrl)
      if (localPath) {
        audioPath = localPath
      } else {
        audioPath = path.join(tmpDir, 'voiceover.mp3')
        const buf = await fetchMediaBuffer(audioUrl, { timeout: 30_000 })
        fs.writeFileSync(audioPath, buf)
      }

      // ── 3. 测量音频时长 & 各分镜时长（缓存已记录精确时长） ─────────────────
      const audioDur   = await probeDuration(audioPath)
      const videoDurs  = succeeded.map(r => r.duration)
      const videoTotal = videoDurs.reduce((a, b) => a + b, 0)
      const gap = audioDur - videoTotal

      // ── 4. 生成 SRT（只在标点处断句，每个分镜音频 < 视频时长）──────────────
      let srtContent = null
      const fullText = (fullSubtitle || '').trim() || validVideos.map(v => (v.subtitle || '').trim()).join('')
      if (fullText) {
        const sentences = splitAtPunctuation(fullText)
        const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1

        // 按字数比例估算每个句子的音频时长
        const sentenceDurs = sentences.map(s => audioDur * (s.length / totalChars))

        // 贪心分配：累计句子到当前分镜，直到加下一句会超过视频时长
        const shotSentences = videoDurs.map(() => [])
        let shotIdx = 0, shotAccum = 0
        for (let i = 0; i < sentences.length; i++) {
          const sDur = sentenceDurs[i]
          // 如果当前分镜加上这句会超限，且当前分镜已有内容，则移到下一个分镜
          if (shotAccum + sDur > videoDurs[shotIdx] && shotAccum > 0 && shotIdx < videoDurs.length - 1) {
            shotIdx++
            shotAccum = 0
          }
          shotSentences[shotIdx].push({ text: sentences[i], dur: sDur })
          shotAccum += sDur
          // 如果当前分镜已满且还有下一个分镜，切换
          if (shotAccum >= videoDurs[shotIdx] && shotIdx < videoDurs.length - 1) {
            shotIdx++
            shotAccum = 0
          }
        }

        // 生成 SRT：按分镜偏移 + 句子时长
        const srtLines = []
        let srtIdx = 1, timeOffset = 0
        for (let si = 0; si < shotSentences.length; si++) {
          for (const { text, dur } of shotSentences[si]) {
            // 字幕行再按显示长度拆分（不超过30字/行），但时间不拆
            const displayChunks = chunkSubtitle(text, 30)
            const chunkDur = dur / displayChunks.length
            for (const chunk of displayChunks) {
              const display = chunk.replace(/[。！？…；，、,;.!?：:]+$/, '')
              srtLines.push(`${srtIdx++}`)
              srtLines.push(`${toSRTTime(timeOffset)} --> ${toSRTTime(timeOffset + chunkDur)}`)
              srtLines.push(display)
              srtLines.push('')
              timeOffset += chunkDur
            }
          }
        }
        srtContent = srtLines.join('\n')
      }

      // ── 5. concat 所有分镜（无音频） ──────────────────────────────────────────
      const concatTxt = path.join(tmpDir, 'concat.txt')
      const videoOnly = path.join(tmpDir, 'video_only.mp4')
      fs.writeFileSync(concatTxt, videoPaths.map(p => `file '${p}'`).join('\n'))

      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatTxt,
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        videoOnly,
      ], { timeout: 600_000 })

      // ── 6. 对齐时长 + 烧字幕 + 叠加语音 ─────────────────────────────────────
      const outName = `voiceover-${Date.now()}.mp4`
      const outPath = path.join(UPLOAD_DIR, outName)
      const base    = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')

      const srtPath = path.join(tmpDir, 'subtitles.srt')
      if (srtContent) {
        fs.writeFileSync(srtPath, srtContent, 'utf8')
      }

      const fontPath = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
      const fontExists = fs.existsSync(fontPath)
      const subtitleFilter = srtContent
        ? `subtitles='${srtPath.replace(/'/g, "'\\''")}':force_style='FontName=${fontExists ? 'Noto Sans CJK SC' : 'Sans'},FontSize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H80000000,BackColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=50'`
        : null

      if (gap > 0.3) {
        const freezePath = path.join(tmpDir, 'video_freeze.mp4')
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly,
          '-vf', `tpad=stop_mode=clone:stop_duration=${(gap + 0.3).toFixed(2)}`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
          freezePath,
        ], { timeout: 300_000 })

        if (subtitleFilter) {
          const withSubs = path.join(tmpDir, 'video_subs.mp4')
          await execFileAsync('ffmpeg', [
            '-y', '-i', freezePath, '-vf', subtitleFilter,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
            withSubs,
          ], { timeout: 300_000 })
          await execFileAsync('ffmpeg', [
            '-y', '-i', withSubs, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest', outPath,
          ], { timeout: 300_000 })
        } else {
          await execFileAsync('ffmpeg', [
            '-y', '-i', freezePath, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest', outPath,
          ], { timeout: 300_000 })
        }
      } else {
        if (subtitleFilter) {
          const withSubs = path.join(tmpDir, 'video_subs.mp4')
          await execFileAsync('ffmpeg', [
            '-y', '-i', videoOnly, '-vf', subtitleFilter,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
            withSubs,
          ], { timeout: 300_000 })
          await execFileAsync('ffmpeg', [
            '-y', '-i', withSubs, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-t', audioDur.toFixed(3), outPath,
          ], { timeout: 300_000 })
        } else {
          await execFileAsync('ffmpeg', [
            '-y', '-i', videoOnly, '-i', audioPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-t', audioDur.toFixed(3), outPath,
          ], { timeout: 300_000 })
        }
      }

      return {
        success: true,
        data: {
          url: `${base}/uploads/${outName}`,
          audioDur: Math.round(audioDur * 10) / 10,
          videoDur: Math.round(videoTotal * 10) / 10,
          gapSeconds: Math.round(Math.max(0, gap) * 10) / 10,
        },
      }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  fastify.post('/merge-images', {
    schema: {
      body: {
        type: 'object', required: ['shots', 'audioUrl'],
        properties: {
          shots: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object',
              properties: {
                imageUrl: { type: 'string' },
                subtitle: { type: 'string' },
                duration: { type: 'number' },
              },
            },
          },
          audioUrl: { type: 'string' },
          voice:    { type: 'string' },
          ratio:    { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { shots, audioUrl, voice, ratio = '9:16' } = request.body
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceover-imgmerge-'))

    const RATIO_MAP = { '9:16': [1080,1920], '16:9': [1920,1080], '1:1': [1080,1080], '4:3': [1440,1080], '3:4': [1080,1440], '21:9': [2520,1080] }
    const [W, H] = RATIO_MAP[ratio] || [1080, 1920]

    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })

      // 下载音频
      let audioPath
      const localPath = localUploadPath(audioUrl)
      if (localPath) {
        audioPath = localPath
      } else {
        audioPath = path.join(tmpDir, 'voiceover.mp3')
        fs.writeFileSync(audioPath, await fetchMediaBuffer(audioUrl, { timeout: 30_000 }))
      }

      const audioDur = await probeDuration(audioPath)

      // 按字幕字数分配时长使总时长匹配音频
      const charCounts = shots.map(s => (s.subtitle || '').replace(/\s/g, '').length)
      const totalChars = charCounts.reduce((a, b) => a + b, 0) || 1
      const shotDurs = charCounts.map(chars => {
        const raw = audioDur * (chars / totalChars)
        return Math.max(0.5, Math.round(raw * 100) / 100)
      })

      const srtLines = []
      let srtIdx = 1, srtOffset = 0
      shots.forEach((shot, i) => {
        const dur  = shotDurs[i]
        const text = (shot.subtitle || '').trim()
        if (text) {
          const chunks     = chunkSubtitle(text)
          const totalC = chunks.reduce((s, c) => s + c.length, 0)
          let chunkOffset  = srtOffset
          chunks.forEach(chunk => {
            const chunkDur = totalC > 0 ? dur * (chunk.length / totalC) : dur / chunks.length
            const display = chunk.replace(/[。！？…；，、,;.!?：:]+$/, '')
            srtLines.push(`${srtIdx++}`)
            srtLines.push(`${toSRTTime(chunkOffset)} --> ${toSRTTime(chunkOffset + chunkDur)}`)
            srtLines.push(display)
            srtLines.push('')
            chunkOffset += chunkDur
          })
        }
        srtOffset += dur
      })
      const preciseSRT = srtLines.join('\n')

      const videoPaths = await Promise.all(
        shots.map(async ({ imageUrl }, i) => {
          const dest = path.join(tmpDir, `shot_${String(i + 1).padStart(3,'0')}.mp4`)
          const dur  = shotDurs[i]

          if (imageUrl) {
            const imgExt  = path.extname(imageUrl.split('?')[0]) || '.jpg'
            const imgPath = path.join(tmpDir, `img_${i}${imgExt}`)
            fs.writeFileSync(imgPath, await fetchMediaBuffer(imageUrl, { timeout: 30_000 }))
            await execFileAsync('ffmpeg', [
              '-y', '-loop', '1', '-i', imgPath,
              '-t', dur.toFixed(3),
              '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '25', '-an',
              dest,
            ], { timeout: 120_000 })
          } else {
            await execFileAsync('ffmpeg', [
              '-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:rate=25`,
              '-t', dur.toFixed(3),
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
              dest,
            ], { timeout: 120_000 })
          }
          return dest
        })
      )

      const concatTxt = path.join(tmpDir, 'concat.txt')
      fs.writeFileSync(concatTxt, videoPaths.map(p => `file '${p}'`).join('\n'))

      const outName = `voiceover-img-${Date.now()}.mp4`
      const outPath = path.join(UPLOAD_DIR, outName)
      const base    = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '')

      const hasSubtitles = shots.some(s => s.subtitle?.trim())

      const videoOnly = path.join(tmpDir, 'video_only.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0', '-i', concatTxt,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
        videoOnly,
      ], { timeout: 600_000 })

      if (hasSubtitles) {
        const srtPath = path.join(tmpDir, 'subtitles.srt')
        fs.writeFileSync(srtPath, preciseSRT, 'utf8')

        const fontPath = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
        const fontExists = fs.existsSync(fontPath)
        const subtitleFilter = `subtitles='${srtPath.replace(/'/g, "'\\''")}':force_style='FontName=${fontExists ? 'Noto Sans CJK SC' : 'Sans'},FontSize=16,PrimaryColour=&HFFFFFF,OutlineColour=&H80000000,BackColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=50'`

        const withSubs = path.join(tmpDir, 'video_subs.mp4')
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly, '-vf', subtitleFilter,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an',
          withSubs,
        ], { timeout: 300_000 })

        await execFileAsync('ffmpeg', [
          '-y', '-i', withSubs, '-i', audioPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', outPath,
        ], { timeout: 300_000 })
      } else {
        await execFileAsync('ffmpeg', [
          '-y', '-i', videoOnly, '-i', audioPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
          '-shortest', outPath,
        ], { timeout: 300_000 })
      }

      return { success: true, data: { url: `${base}/uploads/${outName}` } }
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
}

module.exports = voiceoverRoutes
