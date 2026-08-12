'use client';

import { Fragment, useRef, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '@/lib/api';
import styles from './page.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface VoiceoverShot {
  shot_number:    number;
  title:          string;
  subtitle:       string;
  description:    string;
  prompt:         string;
  duration:       number;
  ratio:          string;
  camera_movement:string;
  mood:           string;
  imageUrl?:      string;
  subjects?:      string[];
}

interface ShotTask {
  shotIndex: number;
  taskId:    string | null;
  status:    string;
  videoUrl:  string | null;
  localUrl:  string | null;
  duration:  number | null;
  error:     string | null;
  submitting:boolean;
}

interface InitResult {
  autoShotCount:      number;
  shotCount:          number;
  characterAnchor?:   string;
  shots:              VoiceoverShot[];
  totalVideoDuration: number;
}

interface BatchTask {
  id: string;
  name: string;
  script: string;
  style: string;
  ratio: string;
  seed: number | null;
  shots: VoiceoverShot[];
  media_items: MediaItem[];
  params: Record<string, any>;
  subject_defs: string;
  subtitle_input: string;
  tasks: Record<number, ShotTask>;
  merged_video_url: string | null;
  audio_url: string | null;
  created_at: string;
  updated_at: string;
}

// ─── State persistence ────────────────────────────────────────────────────────

const WORK_KEY = 'seedance_v3_work_v1'

interface PersistedWork {
  script:        string;
  style:         string;
  ratio:         string;
  initResult:    InitResult | null;
  shots:         VoiceoverShot[];
  tasks:         Record<number, ShotTask>;
  mergedVideoUrl:string | null;
  subtitleInput?: string;
  audioUrl?:     string | null;
  voice?:        string;
  batchId?:      string | null;
  subtitleStyle?: SubtitleStyle;
  banner?:       string;
  bannerStyle?:  BannerStyle;
  mergeId?:      string | null;
}

function loadWork(): PersistedWork | null {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(WORK_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveWork(w: PersistedWork) {
  try { localStorage.setItem(WORK_KEY, JSON.stringify(w)); } catch {}
}

function clearWork() {
  try { localStorage.removeItem(WORK_KEY); } catch {}
}

// ─── Media types ──────────────────────────────────────────────────────────────

interface MediaItem {
  uid?: string;
  mediaType?: 'image' | 'video' | 'audio';
  url?: string;
  mimeType?: string;
  previewUrl?: string;
  name?: string;
  uploading?: boolean;
  uploadProgress?: number;
}

interface AvatarItem { assetId: string; label: string; thumb: string; }

const MEDIA_LIMITS = { image: 8, video: 4, audio: 4 } as const;
const MEDIA_ZH     = { image: '图片', video: '视频', audio: '音频' } as const;

const API_BASE = '/api';

// ─── Upload helpers ────────────────────────────────────────────────────────────

function uploadWithProgress(file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).data.url); }
        catch { reject(new Error('响应解析失败')); }
      } else {
        try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)); }
        catch { reject(new Error(`HTTP ${xhr.status}`)); }
      }
    };
    xhr.onerror   = () => reject(new Error('网络错误'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(form);
  });
}

function getVideoInfo(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el  = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve({ duration: el.duration, width: el.videoWidth, height: el.videoHeight }); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取视频信息')); };
    el.src = url;
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODELS = [
  { value: 'doubao-seedance-2-0-fast',        label: 'Seedance 2.0 Fast' },
  { value: 'doubao-seedance-2-0',             label: 'Seedance 2.0' },
  { value: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast (260128)' },
  { value: 'doubao-seedance-2-0-260128',      label: 'Seedance 2.0 (260128)' },
];

const RESOLUTIONS = [
  { value: '720p',  label: '720p' },
  { value: '1080p', label: '1080p' },
];

const RATIOS = [
  { value: '21:9', label: '21:9' },
  { value: '16:9', label: '16:9' },
  { value: '4:3',  label: '4:3' },
  { value: '1:1',  label: '1:1' },
  { value: '3:4',  label: '3:4' },
  { value: '9:16', label: '9:16' },
];

const STYLES = [
  { label: '专业商务', value: '专业简洁的商务感，柔光棚拍：均匀柔光、浅景深、干净背景，冷调为主，专业可信的讲解氛围' },
  { label: '高级冷调', value: '高级质感冷调，冷白主光加局部暖色点缀，玻璃与金属反光，极简深色背景，高端理财与资产配置氛围' },
  { label: '温暖生活', value: '温暖亲切的生活感，暖调黄金时刻侧光，自然通透，居家或户外场景，适合家庭、养老与传承主题' },
  { label: '个人IP', value: '个人品牌权威感，人物中近景，边缘光轮廓、深色背景突出主体，沉稳可信的顾问出镜风格' },
  { label: '电影质感', value: '电影级画面质感，戏剧化布光与浅景深，细腻颗粒感与高级色调，情绪饱满、叙事感强' },
  { label: '明亮活力', value: '明亮生活化风格，自然光通透明亮，节奏轻快，适合年轻客群与日常场景科普' },
];

const AZURE_VOICES = [
  { value: 'zh-CN-YunfengNeural',   label: '云枫（磁性男声）' },
  { value: 'zh-CN-XiaoxiaoNeural',  label: '晓晓（温柔女声）' },
  { value: 'zh-CN-YunxiNeural',     label: '云希（专业男声）' },
  { value: 'zh-CN-XiaoyiNeural',    label: '晓伊（活泼女声）' },
  { value: 'zh-CN-YunyangNeural',   label: '云扬（新闻男声）' },
  { value: 'zh-CN-XiaohanNeural',   label: '晓涵（成熟女声）' },
  { value: 'zh-CN-XiaoqiuNeural',   label: '晓秋（知性女声）' },
  { value: 'zh-CN-YunjianNeural',   label: '云健（激昂男声）' },
  { value: 'zh-CN-XiaochenNeural',  label: '晓辰（自然女声）' },
  { value: 'zh-CN-YunhaoNeural',    label: '云皓（活力男声）' },
  { value: 'zh-CN-XiaomoNeural',    label: '晓墨（多情感女声）' },
  { value: 'zh-CN-XiaoyanNeural',   label: '晓颜（甜美女声）' },
  { value: 'zh-HK-HiuMaanNeural',   label: '晓曼（粤语女声）' },
  { value: 'zh-HK-WanLungNeural',   label: '云龙（粤语男声）' },
  { value: 'zh-HK-HiuGaaiNeural',   label: '晓佳（粤语女声·活泼）' },
];

const SUBTITLE_FONTS = [
  { value: 'Noto Sans CJK SC',       label: '思源黑体' },
  { value: 'Noto Serif CJK SC',      label: '思源宋体' },
  { value: 'Noto Sans CJK SC Medium', label: '思源黑体 中粗' },
  { value: 'Noto Serif CJK SC SemiBold', label: '思源宋体 半粗' },
  { value: 'WenQuanYi Zen Hei',      label: '文泉驿正黑' },
  { value: 'DejaVu Sans',            label: 'DejaVu Sans' },
  { value: 'Liberation Sans',        label: 'Liberation Sans' },
];

const SUBTITLE_POSITIONS = [
  { value: 'bottom', label: '底部' },
  { value: 'top',    label: '顶部' },
  { value: 'center', label: '居中' },
];

interface SubtitleStyle {
  font: string;
  fontSize: number;
  color: string;
  alpha: number;
  position: string;
  borderW: number;
  borderColor: string;
  borderAlpha: number;
}

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: 'Noto Sans CJK SC',
  fontSize: 4.2,
  color: '#FFFFFF',
  alpha: 1.0,
  position: 'bottom',
  borderW: 1,
  borderColor: '#000000',
  borderAlpha: 0.5,
};

interface BannerStyle {
  fontSize:    number;
  color:       string;
  alpha:       number;
  borderW:     number;
  borderColor: string;
  borderAlpha: number;
  shadowX:     number;
  shadowY:     number;
  shadowColor: string;
  boxEnabled:  boolean;
  boxColor:    string;
  boxAlpha:    number;
}

const DEFAULT_BANNER_STYLE: BannerStyle = {
  fontSize:    2.8,
  color:       '#ffffff',
  alpha:       1.0,
  borderW:     2,
  borderColor: '#000000',
  borderAlpha: 0.6,
  shadowX:     0,
  shadowY:     0,
  shadowColor: '#000000',
  boxEnabled:  false,
  boxColor:    '#000000',
  boxAlpha:    0.5,
};

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'cancelled']);
const STATUS_LABELS: Record<string, string> = {
  running:   '生成中…',
  queued:    '队列中…',
  pending:   '等待中…',
  succeeded: '生成成功',
  failed:    '生成失败',
  idle:      '待提交',
};

const EXAMPLE_SCRIPTS = [
  {
    label: '产品介绍',
    text: '你是否曾经困扰于每天上班通勤的漫长等待？今天，我要给你介绍一款彻底改变我生活的神器。这款便携式颈部按摩仪，专为上班族设计，只需五分钟，就能消除一天的疲劳。采用了日本进口的芯片技术，模拟专业按摩师的手法，拥有八种不同的按摩模式。更重要的是，它轻巧到可以放进口袋，随时随地享受专属按摩。已经有超过十万用户体验，好评率高达百分之九十八。现在下单，还享有三十天无理由退换货保障，错过真的会后悔！',
  },
  {
    label: '励志演讲',
    text: '每一个成功的背后，都有无数个不为人知的艰难时刻。你以为别人的成功是天赋，其实是他们在你看不见的地方，默默努力了无数个日夜。失败了没关系，重要的是你有没有从中学到了什么。人生最大的遗憾，不是努力了没有成功，而是本可以成功，却没有努力。从今天开始，不要再为昨天的错误而懊悔，把每一分钟都用来创造更好的明天。记住，你比你想象中更加强大。',
  },
  {
    label: '旅游攻略',
    text: '大家好，今天带大家云游号称"人间天堂"的西藏。这里海拔超过四千米，空气中的氧气含量只有平原的一半，但这并不妨碍它成为无数人心中的圣地。布达拉宫，傲立于玛布日山上已逾一千三百年，金色的屋顶在阳光下熠熠生辉，那一刻你会觉得，所有的跋涉都是值得的。纳木错，藏语意为"天湖"，湖水清澈见底，倒映着连绵雪山，那种蓝色是你此生见过最纯粹的颜色。去西藏，不仅是一场旅行，更是一次心灵的朝圣。',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}

function estimateScriptDuration(text: string): number {
  return Math.round(text.replace(/\s/g, '').length / 3.5);
}

function recommendShotCount(durationSec: number): number {
  return Math.max(2, Math.min(20, Math.round(durationSec / 10)));
}

// ─── AvatarLibrary ────────────────────────────────────────────────────────────

const AVATAR_GAP = 6;

function AvatarLibrary({ avatars, selectedIds, onAdd, onRemove }: {
  avatars: AvatarItem[];
  selectedIds: string[];
  onAdd: (assetId: string, label: string) => void;
  onRemove: (assetId: string) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const scrollRef           = useRef<HTMLDivElement>(null);
  const [cols, setCols]     = useState(7);
  const [rowH, setRowH]     = useState(120);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = (w: number) => {
      const c = Math.min(9, Math.max(4, Math.floor((w + AVATAR_GAP) / (72 + AVATAR_GAP))));
      const itemW = (w - (c - 1) * AVATAR_GAP) / c;
      setRowH(Math.round(itemW * 4 / 3) + AVATAR_GAP);
      setCols(c);
    };
    update(el.clientWidth);
    const ro = new ResizeObserver(([e]) => update(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const filtered = search.trim() ? avatars.filter(a => a.label.includes(search.trim())) : avatars;
  const rows: AvatarItem[][] = [];
  for (let i = 0; i < filtered.length; i += cols) rows.push(filtered.slice(i, i + cols));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 4,
  });

  return (
    <div className={`${styles.card} ${styles.cardPurple}`}>
      <div className={styles.cardHead}>
        <button type="button" onClick={() => setOpen(v => !v)} className={styles.avatarToggle}>
          <span className={styles.cardTitle}>
            备用人像库{!open && <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>(点击展开)</span>}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{open ? `点击添加（${filtered.length} 人）` : `${avatars.length} 人`}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ width: 16, height: 16, color: '#9ca3af', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </span>
        </button>
        {open && (
          <input type="text" placeholder="搜索职业、国籍、年龄…" value={search}
            onChange={e => setSearch(e.target.value)} className={styles.avatarSearch} />
        )}
      </div>
      {open && (
        <div style={{ padding: '0 0 12px' }}>
          <div ref={scrollRef} style={{ height: rowH * 2, overflowY: 'auto' }}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vRow => {
                const rowItems = rows[vRow.index];
                return (
                  <div key={vRow.index} style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: rowH - AVATAR_GAP, display: 'flex', gap: AVATAR_GAP }}>
                    {rowItems.map(av => {
                      const selected = selectedIds.includes(av.assetId);
                      return (
                        <div key={av.assetId}
                          style={{ flex: '1 1 0', minWidth: 0, height: rowH - AVATAR_GAP, position: 'relative' }}
                          className={selected ? `${styles.avatarItem} ${styles.avatarItemSelected}` : styles.avatarItem}
                          onClick={() => selected ? onRemove(av.assetId) : onAdd(av.assetId, av.label)}>
                          <img src={av.thumb} alt={av.label} loading="lazy" className={styles.avatarImg} style={{ height: '100%' }} />
                          <div className={styles.avatarName}>{av.label.replace(/_/g, ' ')}</div>
                          {selected && <div className={styles.avatarCheck}><span style={{ background: '#7c3aed', color: '#fff', borderRadius: '50%', padding: '1px 4px', fontSize: 10 }}>✓</span></div>}
                        </div>
                      );
                    })}
                    {Array.from({ length: cols - rowItems.length }).map((_, i) => <div key={i} style={{ flex: '1 1 0' }} />)}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ pointerEvents: 'none', marginTop: -24, height: 24, background: 'linear-gradient(to top, #fff, transparent)' }} />
        </div>
      )}
    </div>
  );
}

// ─── MediaPanel ───────────────────────────────────────────────────────────────

// ─── AssetLibrary (真人资源 + 虚拟人像 from API) ─────────────────────────────

interface RemoteAsset {
  Id: string;
  Name: string | null;
  AssetType: string;
  Status?: string;
  PreviewUrl?: string;
  _thumbnail_url?: string;
  URL?: string;
  GroupId?: string;
}

function AssetLibrary({ groupType, title, color, selectedIds, onAdd, onRemove }: {
  groupType: 'AIGC' | 'LivenessFace';
  title: string;
  color?: string;
  selectedIds: string[];
  onAdd: (assetId: string, label: string, previewUrl?: string) => void;
  onRemove: (assetId: string) => void;
}) {
  const [assets, setAssets] = useState<RemoteAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ Items: RemoteAsset[] }>(`/assets/all?groupType=${groupType}`);
      if (data?.Items) {
        setAssets(data.Items);
      }
    } catch {}
    setLoading(false);
    setLoaded(true);
  }, [groupType]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color || '#1d4ed8' }}>{title}</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{expanded ? '▼' : '▶'} {assets.length}</span>
      </div>

      {expanded && (
        <>
          {loading && !loaded && <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>加载中...</p>}

          {loaded && assets.length === 0 && (
            <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              暂无，到 <a href={groupType === 'LivenessFace' ? '/assets/real' : '/assets/virtual'} style={{ color: '#2563eb', fontSize: 11 }}>资源管理</a> 添加
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 5, maxHeight: 220, overflowY: 'auto', marginTop: 8 }}>
            {assets.map(asset => {
              const selected = selectedIds.includes(asset.Id);
              const thumb = asset.PreviewUrl || asset._thumbnail_url || asset.URL || undefined;
              return (
                <div key={asset.Id}
                  onClick={() => selected ? onRemove(asset.Id) : onAdd(asset.Id, asset.Name || asset.Id, thumb)}
                  style={{
                    position: 'relative', borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
                    border: selected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                    aspectRatio: '3/4', background: '#f8fafc',
                  }}>
                  {thumb ? (
                    <img src={thumb} alt={asset.Name || ''} loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9ca3af', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 18 }}>👤</span>
                      <span style={{ fontSize: 10 }}>{asset.Name || asset.AssetType}</span>
                    </div>
                  )}
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,.6))', padding: '10px 3px 2px', fontSize: 9, color: '#fff', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {asset.Name || asset.Id.slice(0, 8)}
                  </div>
                  {selected && (
                    <div style={{ position: 'absolute', top: 3, right: 3 }}>
                      <span style={{ background: '#2563eb', color: '#fff', borderRadius: '50%', padding: '1px 3px', fontSize: 9 }}>✓</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── MediaPanel (file upload) ─────────────────────────────────────────────────

function MediaPanel({ items, onAddFiles, onRemove, uploadError }: {
  items: MediaItem[];
  onAddFiles: (files: File[]) => void;
  onRemove: (idx: number) => void;
  uploadError?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function typeLabel(idx: number): string {
    const t = items[idx].mediaType!;
    const n = items.slice(0, idx + 1).filter(m => m.mediaType === t).length;
    return `${MEDIA_ZH[t]}${n}`;
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div>
        {(['image', 'video', 'audio'] as const).map(t => {
          const group = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item.mediaType === t);
          if (group.length === 0) return null;
          return (
            <div key={t} className={styles.mediaGroup}>
              {group.map(({ item, idx }) => {
                const label = typeLabel(idx);
                const pct   = item.uploadProgress ?? 0;
                const badgeCls = t === 'image' ? styles.mediaBadgeImg : t === 'video' ? styles.mediaBadgeVid : styles.mediaBadgeAud;
                return (
                  <div key={item.uid ?? idx} className={item.uploading ? `${styles.mediaChip} ${styles.mediaChipUploading}` : styles.mediaChip}>
                    {item.previewUrl ? (
                      <div style={{ position: 'relative', width: 32, height: 32, flexShrink: 0 }}>
                        <img src={item.previewUrl} alt="" className={styles.mediaPreview} />
                        {item.uploading && (
                          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'rgba(0,0,0,.5)' }}>
                            <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{pct}%</span>
                          </div>
                        )}
                      </div>
                    ) : t === 'video' ? (
                      <span style={{ flexShrink: 0, fontSize: 16, lineHeight: 1 }}>{item.uploading ? '...' : '🎞'}</span>
                    ) : t === 'audio' ? (
                      <span style={{ flexShrink: 0, fontSize: 16, lineHeight: 1 }}>{item.uploading ? '...' : '🎵'}</span>
                    ) : null}
                    <span className={`${styles.mediaBadge} ${badgeCls}`}>{item.uploading ? `${pct}%` : label}</span>
                    <button type="button" onClick={() => onRemove(idx)} disabled={item.uploading} className={styles.mediaRemove}>×</button>
                    {item.uploading && <div className={styles.mediaProgress}><div className={styles.mediaProgressBar} style={{ width: `${pct}%` }} /></div>}
                  </div>
                );
              })}
            </div>
          );
        })}
        <input ref={inputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
          onChange={e => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        {uploadError && <p className={styles.errInline} style={{ marginTop: 6 }}>{uploadError}</p>}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChipGroup({ label, options, value, onChange, pill }: {
  label: string; options: { value: string | number; label: string }[];
  value: string | number; onChange: (v: string | number) => void; pill?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <span className={styles.paramLabel}>{label}</span>
      <div className={styles.chipGroup} style={{ marginBottom: 0 }}>
        {options.map(o => {
          const active = value === o.value;
          const cls = pill
            ? (active ? `${styles.chip} ${styles.chipPill} ${styles.chipPillActive}` : `${styles.chip} ${styles.chipPill}`)
            : (active ? `${styles.chip} ${styles.chipActive}` : styles.chip);
          return <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cls}>{o.label}</button>;
        })}
      </div>
    </div>
  );
}

function Toggle({ enabled, onToggle, label }: { enabled: boolean; onToggle: () => void; label: string }) {
  return (
    <div className={styles.toggleRow} onClick={onToggle}>
      <div className={enabled ? `${styles.toggleTrack} ${styles.toggleTrackOn}` : styles.toggleTrack}>
        <span className={enabled ? `${styles.toggleKnob} ${styles.toggleKnobOn}` : styles.toggleKnob} />
      </div>
      <span className={styles.toggleLabel}>{label}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'succeeded' ? styles.statusSucceeded
    : status === 'failed'  ? styles.statusFailed
    : status === 'running' ? styles.statusRunning
    : status === 'queued'  ? styles.statusQueued
    : status === 'idle'    ? styles.statusIdle
    : styles.statusPending;
  return <span className={`${styles.statusBadge} ${cls}`}>{STATUS_LABELS[status] || status}</span>;
}

function VideoThumb({ src, ratio = '9:16', subtitle }: { src: string; ratio?: string; subtitle?: string }) {
  const [open, setOpen] = useState(false);
  const [w, h] = ratio.split(':').map(Number);
  return (
    <>
      <div className={styles.videoThumbWrap} onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
        <video src={src} style={{ aspectRatio: `${w||9}/${h||16}`, height: 100, width: 'auto', display: 'block', borderRadius: 6, border: '1px solid #e5e7eb', objectFit: 'cover' }}
          className={styles.videoThumb} title="点击预览" />
      </div>
      {open && (
        <div className={styles.lightbox} onClick={() => setOpen(false)}>
          <div className={styles.lightboxInner} onClick={e => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} className={styles.lightboxClose}>关闭</button>
            <video src={src} controls autoPlay className={styles.lightboxVideo} />
          </div>
        </div>
      )}
    </>
  );
}

function ParamsPanel(p: {
  model: string; onModelChange: (v: string | number) => void;
  resolution: string; onResolutionChange: (v: string | number) => void;
  ratio: string; onRatioChange: (v: string) => void;
  style: string; onStyleChange: (v: string) => void;
  generateAudio: boolean; onToggleAudio: () => void;
  watermark: boolean; onToggleWatermark: () => void;
  seed: number | null; onSeedChange: (v: number | null) => void;
  serviceTier: string; onServiceTierChange: (v: string) => void;
  priority: number; onPriorityChange: (v: number) => void;
  returnLastFrame: boolean; onToggleReturnLastFrame: () => void;
  draft: boolean; onToggleDraft: () => void;
  webSearch: boolean; onToggleWebSearch: () => void;
  showJsonPreview: boolean; onToggleJsonPreview: () => void;
  subtitleMode: 'on' | 'off'; onSubtitleModeChange: (v: 'on' | 'off') => void;
  voice: string; onVoiceChange: (v: string) => void;
  banner: string; onBannerChange: (v: string) => void;
  bannerStyle: BannerStyle; onBannerStyleChange: (v: BannerStyle) => void;
  subtitleStyle: SubtitleStyle; onSubtitleStyleChange: (v: SubtitleStyle) => void;
  duration: number;
  mediaItems: MediaItem[];
}) {
  const is2x = p.model.includes('2-0');
  const is15pro = p.model.includes('1-5') || p.model.includes('1.5');

  const readyMedia = p.mediaItems.filter(m => m.url && !m.uploading);
  const assetImages = readyMedia.filter(m => m.mediaType === 'image' && m.url?.startsWith('asset://'));
  const uploadedImages = readyMedia.filter(m => m.mediaType === 'image' && !m.url?.startsWith('asset://'));
  const videos = readyMedia.filter(m => m.mediaType === 'video');
  const audios = readyMedia.filter(m => m.mediaType === 'audio');

  const contentItems: unknown[] = [{ type: 'text', text: '(prompt内容)' }];
  assetImages.forEach(m => contentItems.push({ type: 'image_url', image_url: { url: m.url!.replace('asset://remote:', 'asset://') }, role: 'reference_image' }));
  uploadedImages.forEach(m => contentItems.push({ type: 'image_url', image_url: { url: m.url }, role: 'reference_image' }));
  videos.forEach(m => contentItems.push({ type: 'video_url', video_url: { url: m.url }, role: 'reference_video' }));
  audios.forEach(m => contentItems.push({ type: 'audio_url', audio_url: { url: m.url }, role: 'reference_audio' }));

  const previewBody: Record<string, unknown> = {
    model: p.model,
    content: contentItems,
    resolution: p.resolution,
    ratio: p.ratio,
    duration: p.duration,
    generate_audio: p.generateAudio,
    watermark: p.watermark,
  };
  if (p.seed !== null) previewBody.seed = p.seed;
  if (p.returnLastFrame) previewBody.return_last_frame = true;
  if (p.draft && is15pro) previewBody.draft = true;
  if (p.serviceTier !== 'default') previewBody.service_tier = p.serviceTier;
  if (p.priority > 0) previewBody.priority = p.priority;
  if (p.webSearch && is2x) previewBody.tools = [{ type: 'web_search' }];

  return (
    <div>
      <p className={styles.cardTitle} style={{ marginBottom: 8 }}>视频参数</p>
      <div>
          {/* 模型 + 分辨率 + 视觉风格 一行 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 2 }}>
              <span className={styles.paramLabel}>模型</span>
              <select value={p.model} onChange={e => p.onModelChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>分辨率</span>
              <select value={p.resolution} onChange={e => p.onResolutionChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>风格</span>
              <select value={p.style} onChange={e => p.onStyleChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {STYLES.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* 比例 + 配音音色 + 服务等级 一行 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>比例</span>
              <select value={p.ratio} onChange={e => p.onRatioChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {RATIOS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <span className={styles.paramLabel}>配音音色</span>
              <select value={p.voice} onChange={e => p.onVoiceChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                {AZURE_VOICES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>服务等级</span>
              <select value={p.serviceTier} onChange={e => p.onServiceTierChange(e.target.value)}
                className={styles.select} style={{ width: '100%', marginTop: 2 }}>
                <option value="default">default</option>
                <option value="standard">standard</option>
                <option value="priority">priority</option>
              </select>
            </div>
          </div>

          {/* Toggles 紧凑一行 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <Toggle enabled={p.generateAudio} onToggle={p.onToggleAudio} label="音频" />
            <Toggle enabled={p.watermark} onToggle={p.onToggleWatermark} label="水印" />
            <Toggle enabled={p.returnLastFrame} onToggle={p.onToggleReturnLastFrame} label="尾帧" />
            {is15pro && <Toggle enabled={p.draft} onToggle={p.onToggleDraft} label="样片" />}
            {is2x && <Toggle enabled={p.webSearch} onToggle={p.onToggleWebSearch} label="联网" />}
          </div>

          {/* 随机种子 + 优先级 一行 */}
          <div style={{ display: 'none', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <span className={styles.paramLabel}>种子</span>
              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                <input type="number" placeholder="随机" min={0} max={2147483647}
                  value={p.seed ?? ''}
                  onChange={e => p.onSeedChange(e.target.value ? parseInt(e.target.value) : null)}
                  className={styles.input} style={{ padding: '4px 6px', fontSize: 12 }} />
                {p.seed !== null && <button onClick={() => p.onSeedChange(null)} style={{ fontSize: 10, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>清</button>}
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>优先级</span>
              <input type="range" min={0} max={9} value={p.priority}
                onChange={e => p.onPriorityChange(parseInt(e.target.value))}
                style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: '#6b7280', minWidth: 12 }}>{p.priority}</span>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />

          {/* 视频标语（全程显示） */}
          <div style={{ marginBottom: 4 }}>
            <span className={styles.paramLabel}>视频标语（全程显示）</span>
            <textarea rows={2} value={p.banner} onChange={e => p.onBannerChange(e.target.value)}
              placeholder="输入标语，支持多行，全程显示在顶部…"
              className={styles.input} style={{ width: '100%', marginTop: 2, padding: '3px 5px', fontSize: 11, resize: 'vertical', lineHeight: 1.4 }} />
            {/* 标语样式控件 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '2px 4px', marginTop: 3 }}>
              <div>
                <span className={styles.paramLabel}>字号%</span>
                <input type="number" min={1} max={8} step={0.5}
                  value={p.bannerStyle.fontSize}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, fontSize: parseFloat(e.target.value) || 2.8 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>字色</span>
                <input type="color" value={p.bannerStyle.color}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, color: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>透明度</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.alpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, alpha: parseFloat(e.target.value) ?? 1 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边宽</span>
                <input type="number" min={0} max={8} step={1}
                  value={p.bannerStyle.borderW}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderW: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边色</span>
                <input type="color" value={p.bannerStyle.borderColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.borderAlpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, borderAlpha: parseFloat(e.target.value) ?? 0.6 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影X</span>
                <input type="number" min={0} max={20} step={1}
                  value={p.bannerStyle.shadowX}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowX: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影Y</span>
                <input type="number" min={0} max={20} step={1}
                  value={p.bannerStyle.shadowY}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowY: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>阴影色</span>
                <input type="color" value={p.bannerStyle.shadowColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, shadowColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>背景块</span>
                <select value={p.bannerStyle.boxEnabled ? '1' : '0'}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxEnabled: e.target.value === '1' })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  <option value="0">关</option>
                  <option value="1">开</option>
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>背景色</span>
                <input type="color" value={p.bannerStyle.boxColor}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>背景透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.bannerStyle.boxAlpha}
                  onChange={e => p.onBannerStyleChange({ ...p.bannerStyle, boxAlpha: parseFloat(e.target.value) ?? 0.5 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '6px 0' }} />

          {/* 字幕样式 */}
          <div style={{ marginBottom: 4 }}>
            <span className={styles.paramLabel}>字幕样式</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '2px 4px', marginTop: 3 }}>
              <div style={{ gridColumn: 'span 2' }}>
                <span className={styles.paramLabel}>字体</span>
                <select value={p.subtitleStyle.font} onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, font: e.target.value })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  {SUBTITLE_FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>字号%</span>
                <input type="number" min={1} max={10} step={0.5}
                  value={p.subtitleStyle.fontSize}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, fontSize: parseFloat(e.target.value) || 4.2 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>位置</span>
                <select value={p.subtitleStyle.position} onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, position: e.target.value })}
                  className={styles.select} style={{ width: '100%', marginTop: 1 }}>
                  {SUBTITLE_POSITIONS.map(pos => <option key={pos.value} value={pos.value}>{pos.label}</option>)}
                </select>
              </div>
              <div>
                <span className={styles.paramLabel}>字色</span>
                <input type="color" value={p.subtitleStyle.color}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, color: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>透明度</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.subtitleStyle.alpha}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, alpha: parseFloat(e.target.value) ?? 1 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边宽</span>
                <input type="number" min={0} max={8} step={1}
                  value={p.subtitleStyle.borderW}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderW: parseInt(e.target.value) || 0 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边色</span>
                <input type="color" value={p.subtitleStyle.borderColor}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderColor: e.target.value })}
                  style={{ width: '100%', height: 20, marginTop: 1, cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 3, padding: 1 }} />
              </div>
              <div>
                <span className={styles.paramLabel}>描边透</span>
                <input type="number" min={0} max={1} step={0.1}
                  value={p.subtitleStyle.borderAlpha}
                  onChange={e => p.onSubtitleStyleChange({ ...p.subtitleStyle, borderAlpha: parseFloat(e.target.value) ?? 0.5 })}
                  className={styles.input} style={{ width: '100%', padding: '1px 3px', fontSize: 11, marginTop: 1 }} />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: '#e5e7eb', margin: '8px 0' }} />

          {/* JSON Preview Toggle */}
          <button onClick={p.onToggleJsonPreview}
            style={{ width: '100%', padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6, background: p.showJsonPreview ? '#eff6ff' : '#fff', fontSize: 11, cursor: 'pointer', color: '#374151', textAlign: 'left' }}>
            {p.showJsonPreview ? '▼' : '▶'} 预览 JSON
          </button>
          {p.showJsonPreview && (
            <pre style={{ margin: '6px 0 0', padding: 8, background: '#1e293b', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.4, overflow: 'auto', maxHeight: 300 }}>
              {JSON.stringify(previewBody, null, 2)}
            </pre>
          )}
        </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function VoiceoverPage() {
  const [script, setScript] = useState('');
  const [subtitleInput, setSubtitleInput] = useState('');
  const [style, setStyle]   = useState(STYLES[0].value);
  const [ratio, setRatio]   = useState('9:16');

  const [initResult, setInitResult]   = useState<InitResult | null>(null);
  const [initing, setIniting]         = useState(false);
  const [aiScriptLoading, setAiScriptLoading] = useState(false);
  const [showAiInput, setShowAiInput] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [initError, setInitError]     = useState('');

  const [shots, setShots] = useState<VoiceoverShot[]>([]);

  const [model, setModel]               = useState(MODELS[0].value);
  const [resolution, setResolution]     = useState('720p');
  const [generateAudio, setGenerateAudio] = useState(false);
  const [watermark, setWatermark]         = useState(false);
  const [seed, setSeed]                   = useState<number | null>(null);
  const [serviceTier, setServiceTier]     = useState('default');
  const [priority, setPriority]           = useState(0);
  const [returnLastFrame, setReturnLastFrame] = useState(false);
  const [draft, setDraft]                 = useState(false);
  const [webSearch, setWebSearch]         = useState(false);
  const [subtitleMode, setSubtitleMode]   = useState<'on' | 'off'>('off');
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
  const [banner, setBanner]               = useState('');
  const [bannerStyle, setBannerStyle]     = useState<BannerStyle>(DEFAULT_BANNER_STYLE);
  const [showJsonPreview, setShowJsonPreview] = useState(false);
  const [voice, setVoice]                 = useState('zh-CN-XiaoqiuNeural');
  const [audioUrl, setAudioUrl]           = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [wordBoundaries, setWordBoundaries] = useState<Array<{text: string; offset: number; duration: number}>>([]);
  const [ttsLoading, setTtsLoading]       = useState(false);
  const [tasks, setTasks]                 = useState<Record<number, ShotTask>>({});
  const pollRefs = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const batchSeedRef = useRef<number | null>(null);

  const [merging, setMerging]               = useState(false);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [mergeError, setMergeError]         = useState('');
  const [mergeId, setMergeId]               = useState<string | null>(null);
  const mergePollingRef = useRef<ReturnType<typeof setInterval> | null>(null);


  const [showMobileParams, setShowMobileParams] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [showSubtitleTip, setShowSubtitleTip] = useState(false);
  const [showMediaTip, setShowMediaTip] = useState(false);

  const [mediaItems, setMediaItems]   = useState<MediaItem[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [avatars, setAvatars]         = useState<AvatarItem[]>([]);
  const [avatarSearch, setAvatarSearch] = useState('');
  const [avatarExpanded, setAvatarExpanded] = useState(false);

  const [subjectDefs, setSubjectDefs]         = useState('');
  const [analyzingSubjects, setAnalyzingSubjects] = useState(false);
  const [subjectError, setSubjectError]       = useState('');
  const prevSubjectDefsRef = useRef('');

  const [batchId, setBatchId]               = useState<string | null>(null);
  const [batchName, setBatchName]           = useState('');
  const [batchList, setBatchList]           = useState<BatchTask[]>([]);
  const [showBatchList, setShowBatchList]   = useState(false);
  const [showVoiceSelect, setShowVoiceSelect] = useState(false);
  const [batchLoading, setBatchLoading]     = useState(false);
  const batchSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resetKey, setResetKey]             = useState(0);
  const [workLoaded, setWorkLoaded] = useState(false);

  useEffect(() => {
    fetch('/avatars/index.json').then(r => r.json()).then((data: AvatarItem[]) => setAvatars(data.reverse())).catch(() => {});
    const saved = loadWork();
    if (saved) {
      if (saved.script)         setScript(saved.script);
      if (saved.style)          setStyle(saved.style);
      if (saved.ratio)          setRatio(saved.ratio);
      if (saved.initResult)     setInitResult(saved.initResult);
      if (saved.shots?.length)  setShots(saved.shots);
      if (saved.mergedVideoUrl) setMergedVideoUrl(saved.mergedVideoUrl);
      if (saved.subtitleInput)  setSubtitleInput(saved.subtitleInput);
      else if (saved.shots?.length) setSubtitleInput(saved.shots.map(s => s.subtitle).join(''));
      if (saved.audioUrl)       setAudioUrl(saved.audioUrl);
      if (saved.voice)          setVoice(saved.voice);
      if (saved.batchId)        setBatchId(saved.batchId);
      if (saved.subtitleStyle)  setSubtitleStyle(saved.subtitleStyle);
      if (saved.banner)         setBanner(saved.banner);
      if (saved.bannerStyle)    setBannerStyle(saved.bannerStyle);
      if (saved.mergeId)        setMergeId(saved.mergeId);
      if (saved.tasks && Object.keys(saved.tasks).length) {
        const restoredTasks: Record<number, ShotTask> = {};
        for (const [k, t] of Object.entries(saved.tasks)) {
          restoredTasks[Number(k)] = { ...t, submitting: false };
        }
        setTasks(restoredTasks);
      }
    }
    setWorkLoaded(true);
  }, []);

  useEffect(() => {
    if (!workLoaded) return;
    setTasks(current => {
      for (const [idxStr, t] of Object.entries(current)) {
        const idx = Number(idxStr);
        if (t.taskId && !TERMINAL.has(t.status) && !pollRefs.current[idx]) {
          pollTaskById(idx, t.taskId);
          pollRefs.current[idx] = setInterval(() => pollTaskById(idx, t.taskId!), 10_000);
        }
      }
      return current;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workLoaded]);

  useEffect(() => {
    if (!workLoaded) return;
    if (mergeId && !mergedVideoUrl && !mergePollingRef.current) {
      pollMergeStatus(mergeId);
    }
    return () => {
      if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workLoaded]);

  useEffect(() => {
    if (!workLoaded) return;
    if (initing) return;
    saveWork({ script, style, ratio, initResult, shots, tasks, mergedVideoUrl, subtitleInput, audioUrl, voice, batchId, subtitleStyle, banner, bannerStyle, mergeId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workLoaded, script, style, ratio, initResult, shots, tasks, mergedVideoUrl, subtitleInput, audioUrl, voice, batchId, subtitleStyle, banner, bannerStyle, mergeId]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      setTasks(prev => {
        Object.entries(prev).forEach(([i, t]) => {
          if (t.taskId && !TERMINAL.has(t.status)) pollTaskById(Number(i), t.taskId);
        });
        return prev;
      });
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    Object.values(pollRefs.current).forEach(clearInterval);
  }, []);

  // Auto-update shot prompts when subject definitions change
  useEffect(() => {
    if (shots.length === 0 || !prevSubjectDefsRef.current) {
      prevSubjectDefsRef.current = subjectDefs;
      return;
    }
    const prev = prevSubjectDefsRef.current;
    if (prev === subjectDefs) return;

    // Parse old and new definitions to detect label renames
    const parseLabels = (text: string) => {
      const labels: { line: string; label: string }[] = [];
      for (const line of text.split('\n')) {
        const m = line.match(/定义为[<＜]?([^>＞\n]+)[>＞]?$/);
        if (m) labels.push({ line: line.trim(), label: m[1].trim() });
      }
      return labels;
    };
    const oldLabels = parseLabels(prev);
    const newLabels = parseLabels(subjectDefs);

    // Build rename map (same position = rename)
    const renameMap: Record<string, string> = {};
    for (let i = 0; i < Math.min(oldLabels.length, newLabels.length); i++) {
      if (oldLabels[i].label !== newLabels[i].label) {
        renameMap[oldLabels[i].label] = newLabels[i].label;
      }
    }

    if (Object.keys(renameMap).length > 0) {
      setShots(prev => prev.map(shot => {
        let prompt = shot.prompt;
        for (const [oldLabel, newLabel] of Object.entries(renameMap)) {
          prompt = prompt.replaceAll(oldLabel, newLabel);
        }
        return prompt !== shot.prompt ? { ...shot, prompt } : shot;
      }));
    }

    prevSubjectDefsRef.current = subjectDefs;
  }, [subjectDefs, shots.length]);

  const pollTaskById = useCallback(async (idx: number, taskId: string) => {
    try {
      const d = await api.get<{ status: string; videoUrl: string | null; localUrl?: string | null; duration?: number | null; error: string | null }>(`/video/task/${taskId}`);
      setTasks(prev => ({ ...prev, [idx]: { ...prev[idx], status: d.status, videoUrl: d.videoUrl, localUrl: d.localUrl || null, duration: d.duration || null, error: d.error } }));
      if (TERMINAL.has(d.status)) { clearInterval(pollRefs.current[idx]); delete pollRefs.current[idx]; }
    } catch (e) { console.error('[poll]', e); }
  }, []);

  async function addFiles(files: File[]) {
    const MAX_SIZE = 50 * 1024 * 1024;
    const rejected: string[] = [];
    const batchCount = { image: 0, video: 0, audio: 0 };
    for (const f of files) {
      const mediaType = f.type.startsWith('image/') ? 'image' as const
                      : f.type.startsWith('video/') ? 'video' as const
                      : f.type.startsWith('audio/') ? 'audio' as const
                      : null;
      if (!mediaType) continue;
      if (f.size > MAX_SIZE) { rejected.push(`${f.name}（超过 50MB）`); continue; }
      if (mediaType === 'video') {
        try {
          const { duration, width, height } = await getVideoInfo(f);
          if (duration > 15) { rejected.push(`${f.name}（时长 ${Math.round(duration)}s，超过 15s）`); continue; }
          if (width * height < 409600) { rejected.push(`${f.name}（分辨率不足）`); continue; }
        } catch { rejected.push(`${f.name}（无法读取视频信息）`); continue; }
      }
      const currentCount = mediaItems.filter(m => m.mediaType === mediaType).length + batchCount[mediaType];
      if (currentCount >= MEDIA_LIMITS[mediaType]) continue;
      batchCount[mediaType]++;
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const item: MediaItem = { uid, mediaType, mimeType: f.type, name: f.name, uploading: true, uploadProgress: 0, ...(mediaType === 'image' ? { previewUrl: URL.createObjectURL(f) } : {}) };
      setMediaItems(prev => [...prev, item]);
      uploadWithProgress(f, (pct) => {
        setMediaItems(prev => prev.map(m => m.uid === uid ? { ...m, uploadProgress: pct } : m));
      }).then(url => {
        setMediaItems(prev => prev.map(m => m.uid === uid ? { ...m, url, uploading: false, uploadProgress: 100 } : m));
      }).catch(err => {
        const msg = err instanceof Error ? err.message : '未知错误';
        setUploadError(`${f.name} 上传失败：${msg}`);
        setMediaItems(prev => { const found = prev.find(m => m.uid === uid); if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl); return prev.filter(m => m.uid !== uid); });
      });
    }
    if (rejected.length) setUploadError(`以下文件已跳过：${rejected.join('、')}`);
  }

  function removeMediaItem(idx: number) {
    setMediaItems(prev => { const item = prev[idx]; if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); return prev.filter((_, i) => i !== idx); });
  }

  function handleReset() {
    clearWork();
    setScript(''); setStyle(STYLES[0].value); setRatio('9:16');
    setInitResult(null); setShots([]); setTasks({}); setMergedVideoUrl(null);
    setInitError(''); setMergeError('');
    setMediaItems([]); setUploadError('');
    setSubtitleInput(''); setSubjectDefs('');
    setAudioUrl(null);
    setAudioDuration(0);
    setSeed(null);
    setBatchId(null); setBatchName('');
    setAvatarExpanded(false);
    setResetKey(k => k + 1);
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};
    batchSeedRef.current = null;
  }


  async function handleAnalyzeSubjects() {
    const images = mediaItems.filter(m => m.mediaType === 'image' && !m.uploading && (m.previewUrl || m.url));
    if (images.length === 0) return;
    setAnalyzingSubjects(true); setSubjectError('');
    try {
      const media = images.map(m => ({ url: m.url, mediaType: m.mediaType, previewUrl: m.previewUrl || m.url }));
      const result = await api.post<{ definitions: string[]; summary: string; usageHint: string }>('/voiceover/analyze-subjects', { media });
      const text = result.definitions.join('\n');
      setSubjectDefs(text);
      prevSubjectDefsRef.current = text;
    } catch (err) {
      setSubjectError(err instanceof Error ? err.message : '主体分析失败');
    } finally { setAnalyzingSubjects(false); }
  }

  async function handleInit() {
    if (!script.trim() && !subtitleInput.trim()) return;
    setInitError(''); setIniting(true);
    setInitResult(null); setShots([]); setTasks({}); setMergedVideoUrl(null); setAudioUrl(null);
    batchSeedRef.current = null;
    Object.values(pollRefs.current).forEach(clearInterval);
    pollRefs.current = {};

    // 若有图片素材且尚未定义主体，先自动分析主体
    let resolvedSubjectDefs = subjectDefs.trim();
    const images = mediaItems.filter(m => m.mediaType === 'image' && !m.uploading && (m.previewUrl || m.url));
    if (images.length > 0 && !resolvedSubjectDefs) {
      setAnalyzingSubjects(true); setSubjectError('');
      try {
        const media = images.map(m => ({ url: m.url, mediaType: m.mediaType, previewUrl: m.previewUrl || m.url }));
        const result = await api.post<{ definitions: string[]; summary: string; usageHint: string }>('/voiceover/analyze-subjects', { media });
        resolvedSubjectDefs = result.definitions.join('\n');
        setSubjectDefs(resolvedSubjectDefs);
        prevSubjectDefsRef.current = resolvedSubjectDefs;
      } catch (err) {
        setSubjectError(err instanceof Error ? err.message : '主体分析失败');
      } finally { setAnalyzingSubjects(false); }
    }

    try {
      const readyMedia = mediaItems.filter(m => m.url && !m.uploading);
      const imageCount = readyMedia.filter(m => m.mediaType === 'image').length;
      const videoCount = readyMedia.filter(m => m.mediaType === 'video').length;
      const audioCount = readyMedia.filter(m => m.mediaType === 'audio').length;
      const result = await api.post<InitResult>('/voiceover/init', { script: script.trim(), style, ratio, imageCount, videoCount, audioCount, subjectDefinitions: resolvedSubjectDefs || undefined, subtitleMode, subtitleInput: subtitleInput.trim() || undefined });
      setInitResult(result);
      setShots(result.shots);
      if (!subtitleInput.trim() && result.shots.length > 0) {
        setSubtitleInput(result.shots.map(s => s.subtitle).join(''));
      }
      batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);

      // TTS: 生成语音并按实际时长更新各分镜 duration
      const ttsScript = subtitleInput.trim() || result.shots.map(s => s.subtitle).join('');
      let ttsAudioUrl: string | null = null;
      if (ttsScript) {
        setTtsLoading(true);
        try {
          const ttsRes = await api.post<{ audioUrl: string; totalDuration: number; shotDurations: number[]; totalVideoDuration: number; wordBoundaries?: Array<{text: string; offset: number; duration: number}> }>('/voiceover/tts', {
            script: ttsScript, voice, shots: result.shots.map(s => ({ subtitle: s.subtitle })),
          });
          setAudioUrl(ttsRes.audioUrl);
          setAudioDuration(ttsRes.totalDuration);
          if (ttsRes.wordBoundaries) setWordBoundaries(ttsRes.wordBoundaries);
          ttsAudioUrl = ttsRes.audioUrl;
          const updatedShots = result.shots.map((s, i) => ({ ...s, duration: ttsRes.shotDurations[i] ?? s.duration }));
          setShots(updatedShots);
          result.shots = updatedShots;
          result.totalVideoDuration = ttsRes.totalVideoDuration;
        } catch (e) {
          console.warn('TTS failed, using estimated durations:', e);
        } finally { setTtsLoading(false); }
      }

      const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名任务';
      const batchPayload = {
        name: autoName, script: script.trim(), style, ratio, seed: batchSeedRef.current,
        shots: result.shots, media_items: mediaItems.filter(m => m.url && !m.uploading).map(m => ({ ...m, previewUrl: m.previewUrl?.startsWith('blob:') ? m.url : m.previewUrl })),
        params: { model, resolution, generateAudio, watermark, seed: batchSeedRef.current, serviceTier, priority, returnLastFrame, draft, webSearch, subtitleMode, voice },
        subject_defs: subjectDefs.trim(), subtitle_input: subtitleInput.trim(), tasks: {}, merged_video_url: null,
        audio_url: ttsAudioUrl,
        init_result: result,
      };
      if (batchId) {
        await api.put(`/batch/${batchId}`, batchPayload);
      } else {
        const batch = await api.post<BatchTask>('/batch', batchPayload);
        setBatchId(batch.id);
        setBatchName(autoName);
      }
    } catch (err) {
      setInitError(err instanceof Error ? err.message : '生成失败，请重试');
    } finally { setIniting(false); }
  }

  async function handleRegenTTS() {
    const ttsScript = subtitleInput.trim();
    if (!ttsScript) return;
    setTtsLoading(true);
    try {
      const ttsRes = await api.post<{ audioUrl: string; totalDuration: number; shotDurations: number[]; totalVideoDuration: number; wordBoundaries?: Array<{text: string; offset: number; duration: number}> }>('/voiceover/tts', {
        script: ttsScript, voice, shots: shots.length > 0 ? shots.map(s => ({ subtitle: s.subtitle })) : [{ subtitle: ttsScript }],
      });
      setAudioUrl(ttsRes.audioUrl);
      setAudioDuration(ttsRes.totalDuration);
      if (ttsRes.wordBoundaries) setWordBoundaries(ttsRes.wordBoundaries);
      if (batchId) {
        try { await api.put(`/batch/${batchId}`, { ...getBatchPayload(), subtitle_input: ttsScript, audio_url: ttsRes.audioUrl }); } catch {}
      }
    } catch (e) {
      console.warn('TTS regen failed:', e);
    } finally { setTtsLoading(false); }
  }

  function getBatchPayload() {
    return {
      name: batchName || script.trim().slice(0, 30) || '未命名任务',
      script: script.trim(), style, ratio, seed: batchSeedRef.current,
      shots, media_items: mediaItems.filter(m => m.url && !m.uploading).map(m => ({ ...m, previewUrl: m.previewUrl?.startsWith('blob:') ? m.url : m.previewUrl })),
      params: { model, resolution, generateAudio, watermark, seed: batchSeedRef.current, serviceTier, priority, returnLastFrame, draft, webSearch, subtitleMode, voice },
      subject_defs: subjectDefs.trim(), subtitle_input: subtitleInput.trim(), tasks, merged_video_url: mergedVideoUrl,
      audio_url: audioUrl,
      init_result: initResult,
    };
  }

  function scheduleBatchSave() {
    if (!batchId) return;
    if (batchSaveTimer.current) clearTimeout(batchSaveTimer.current);
    batchSaveTimer.current = setTimeout(async () => {
      try { await api.put(`/batch/${batchId}`, getBatchPayload()); } catch {}
    }, 2000);
  }

  useEffect(() => {
    if (!workLoaded || !batchId) return;
    scheduleBatchSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots, tasks, mergedVideoUrl, mediaItems]);

  async function loadBatchList() {
    setBatchLoading(true);
    try {
      const list = await api.get<BatchTask[]>('/batch');
      setBatchList(list);
    } catch {} finally { setBatchLoading(false); }
  }

  async function restoreBatch(batch: BatchTask) {
    try {
      const full = await api.get<BatchTask>(`/batch/${batch.id}`);
      setScript(full.script || '');
      setStyle(full.style || STYLES[0].value);
      setRatio(full.ratio || '9:16');
      setShots(full.shots || []);
      setSubtitleInput(full.subtitle_input || (full.shots || []).map(s => s.subtitle).join('') || '');
      setSubjectDefs(full.subject_defs || '');
      setMergedVideoUrl(full.merged_video_url || null);
      setAudioUrl(full.audio_url || null);
      if (full.params) {
        if (full.params.model) setModel(full.params.model);
        if (full.params.resolution) setResolution(full.params.resolution);
        if (full.params.generateAudio !== undefined) setGenerateAudio(full.params.generateAudio);
        if (full.params.watermark !== undefined) setWatermark(full.params.watermark);
        if (full.params.serviceTier) setServiceTier(full.params.serviceTier);
        if (full.params.subtitleMode) setSubtitleMode(full.params.subtitleMode);
        if (full.params.webSearch !== undefined) setWebSearch(full.params.webSearch);
        if (full.params.returnLastFrame !== undefined) setReturnLastFrame(full.params.returnLastFrame);
        if (full.params.draft !== undefined) setDraft(full.params.draft);
        if (full.params.voice) setVoice(full.params.voice);
      }
      if (full.seed != null) {
        batchSeedRef.current = full.seed;
        setSeed(full.seed);
      } else if (full.params?.seed != null) {
        batchSeedRef.current = full.params.seed;
        setSeed(full.params.seed);
      }
      if (full.tasks) {
        const restoredTasks: Record<number, ShotTask> = {};
        for (const [k, t] of Object.entries(full.tasks)) {
          restoredTasks[Number(k)] = { ...t, submitting: false };
        }
        setTasks(restoredTasks);
      } else { setTasks({}); }
      if (full.media_items) setMediaItems(full.media_items);
      setInitResult((full as any).init_result || (full.shots?.length ? { autoShotCount: full.shots.length, shotCount: full.shots.length, characterAnchor: '', shots: full.shots, totalVideoDuration: 0 } : null));
      setBatchId(full.id);
      setBatchName(full.name);
      setShowBatchList(false);
    } catch { alert('恢复失败，请重试'); }
  }

  async function deleteBatch(id: string) {
    try {
      await api.del(`/batch/${id}`);
      setBatchList(prev => prev.filter(b => b.id !== id));
      if (batchId === id) setBatchId(null);
    } catch {}
  }

  async function submitShot(idx: number) {
    const shot = shots[idx];
    if (!shot) return;
    setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId: null, status: 'pending', videoUrl: null, localUrl: null, duration: null, error: null, submitting: true } }));
    try {
      // All shots share the same seed for visual consistency
      if (batchSeedRef.current === null) {
        batchSeedRef.current = seed ?? Math.floor(Math.random() * 2147483647);
      }
      const sharedSeed = batchSeedRef.current;
      // Maintain upload order: send media in the same order as mediaItems
      const orderedMedia = mediaItems
        .filter(m => m.url && !m.uploading)
        .map(m => ({
          url: m.url!.startsWith('asset://remote:') ? m.url!.replace('asset://remote:', 'asset://') : m.url!,
          mediaType: m.mediaType,
        }));
      const res = await api.post<{ taskId: string; status: string }>('/video/generate', {
        prompt: shot.prompt, orderedMedia,
        model, resolution, ratio, duration: shot.duration || 8,
        generateAudio, watermark, webSearch,
        seed: sharedSeed,
        returnLastFrame, draft,
        serviceTier: serviceTier !== 'default' ? serviceTier : undefined,
        priority: priority > 0 ? priority : undefined,
      });
      const { taskId, status } = res;
      setTasks(prev => ({ ...prev, [idx]: { shotIndex: idx, taskId, status, videoUrl: null, localUrl: null, duration: null, error: null, submitting: false } }));
      const interval = setInterval(() => pollTaskById(idx, taskId), 10_000);
      pollRefs.current[idx] = interval;
      setTimeout(() => pollTaskById(idx, taskId), 5_000);
    } catch (err) {
      setTasks(prev => ({ ...prev, [idx]: { ...prev[idx], status: 'failed', error: err instanceof Error ? err.message : '提交失败', submitting: false } }));
    }
  }

  async function submitAllShots() {
    for (let i = 0; i < shots.length; i++) {
      const t = tasks[i];
      if (!(t?.status === 'succeeded' || t?.status === 'running' || t?.status === 'queued')) {
        await submitShot(i); await new Promise(r => setTimeout(r, 800));
      }
    }
    // 保存任务
    try {
      const payload = getBatchPayload();
      if (batchId) {
        await api.put(`/batch/${batchId}`, payload);
      } else {
        const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名任务';
        const batch = await api.post<BatchTask>('/batch', { ...payload, name: autoName });
        setBatchId(batch.id); setBatchName(autoName);
      }
    } catch {}
  }

  function pollMergeStatus(mid: string) {
    if (mergePollingRef.current) clearInterval(mergePollingRef.current);
    setMerging(true);
    const check = async () => {
      try {
        const res = await api.get<{ status: string; url?: string; error?: string }>(`/voiceover/merge-status/${mid}`);
        if (res.status === 'done' && res.url) {
          setMergedVideoUrl(res.url);
          setMerging(false); setMergeId(null);
          if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
        } else if (res.status === 'failed') {
          setMergeError(res.error || '合并失败');
          setMerging(false); setMergeId(null);
          if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
        }
      } catch (err) {
        setMergeError(err instanceof Error ? err.message : '合并失败');
        setMerging(false); setMergeId(null);
        if (mergePollingRef.current) { clearInterval(mergePollingRef.current); mergePollingRef.current = null; }
      }
    };
    check();
    mergePollingRef.current = setInterval(check, 3000);
  }

  async function handleMerge() {
    if (!audioUrl) { setMergeError('请先生成语音（TTS）'); return; }
    const succeededShots = shots.map((shot, i) => ({ shot, task: tasks[i] })).filter(({ task }) => task?.status === 'succeeded' && (task.localUrl || task.videoUrl));
    if (succeededShots.length < 1) return;
    const videoList = succeededShots.map(({ shot, task }) => ({ url: (task!.localUrl || task!.videoUrl) as string, subtitle: shot.subtitle || '', duration: task!.duration || shot.duration || 5 }));
    const fullSubtitle = subtitleInput.trim() || shots.map(s => s.subtitle).join('');
    setMerging(true); setMergeError(''); setMergedVideoUrl(null);
    try {
      const res = await api.post<{ mergeId: string }>('/voiceover/merge-async', { videos: videoList, audioUrl, voice, subtitle: fullSubtitle, subtitleStyle, banner, bannerStyle, wordBoundaries });
      setMergeId(res.mergeId);
      pollMergeStatus(res.mergeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合并失败';
      setMergeError(msg.length > 120 ? msg.slice(0, 120) + '…' : msg);
      setMerging(false);
    }
  }

  async function handleImageMerge() {
    if (shots.length === 0 || !audioUrl) { setMergeError('请先生成语音（TTS）'); return; }
    const shotList = shots.map(s => ({ imageUrl: s.imageUrl || undefined, subtitle: s.subtitle || '', duration: s.duration || 5 }));
    setMerging(true); setMergeError(''); setMergedVideoUrl(null);
    try {
      const res = await api.post<{ url: string }>('/voiceover/merge-images', { shots: shotList, audioUrl, voice, ratio, subtitleStyle, banner, bannerStyle, wordBoundaries });
      setMergedVideoUrl(res.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合并失败';
      setMergeError(msg.length > 120 ? msg.slice(0, 120) + '…' : msg);
    } finally { setMerging(false); }
  }

  const anyUploading    = mediaItems.some(m => m.uploading);
  const succeededCount  = Object.values(tasks).filter(t => t.status === 'succeeded').length;
  const allDone         = shots.length > 0 && shots.every((_, i) => { const t = tasks[i]; return t && TERMINAL.has(t.status); });
  const canMerge        = !!audioUrl && succeededCount >= 1;
  const estText         = subtitleInput.trim() || script;
  const estDuration     = estimateScriptDuration(estText);
  const estShotCount    = recommendShotCount(estDuration);

  const paramsProps = {
    model, onModelChange: (v: string | number) => setModel(v as string),
    resolution, onResolutionChange: (v: string | number) => setResolution(v as string),
    ratio, onRatioChange: (v: string) => setRatio(v),
    style, onStyleChange: (v: string) => setStyle(v),
    generateAudio, onToggleAudio: () => setGenerateAudio(v => !v),
    watermark, onToggleWatermark: () => setWatermark(v => !v),
    seed, onSeedChange: (v: number | null) => setSeed(v),
    serviceTier, onServiceTierChange: (v: string) => setServiceTier(v),
    priority, onPriorityChange: (v: number) => setPriority(v),
    returnLastFrame, onToggleReturnLastFrame: () => setReturnLastFrame(v => !v),
    draft, onToggleDraft: () => setDraft(v => !v),
    webSearch, onToggleWebSearch: () => setWebSearch(v => !v),
    showJsonPreview, onToggleJsonPreview: () => setShowJsonPreview(v => !v),
    subtitleMode, onSubtitleModeChange: (v: 'on' | 'off') => setSubtitleMode(v),
    voice, onVoiceChange: (v: string) => setVoice(v),
    banner, onBannerChange: (v: string) => setBanner(v),
    bannerStyle, onBannerStyleChange: (v: BannerStyle) => setBannerStyle(v),
    subtitleStyle, onSubtitleStyleChange: (v: SubtitleStyle) => setSubtitleStyle(v),
    duration: shots[0]?.duration || 8,
    mediaItems,
  };

  return (
    <div className={styles.page}>
      <div className={styles.body}>
        <div style={{ position: 'sticky', top: 44, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f8fafc', gap: 8 }} className={styles.mobileParamsToggle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>当前任务：</span>
            {batchId ? (
              <input type="text" value={batchName} onChange={e => setBatchName(e.target.value)}
                onBlur={() => { if (batchId) api.put(`/batch/${batchId}`, getBatchPayload()).catch(() => {}); }}
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', fontSize: 13, fontWeight: 600, color: '#1e293b', outline: 'none' }} />
            ) : (
              <span style={{ fontSize: 13, color: '#94a3b8' }}>未创建</span>
            )}
          </div>
          <button type="button" onClick={() => { setShowBatchList(true); loadBatchList(); }}
            style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: '#2563eb', background: 'none', border: '1px solid #2563eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
            历史任务
          </button>
          <button type="button" onClick={() => setShowMobileParams(v => !v)}
            className={styles.paramsBtnBlue}>
            {showMobileParams ? '收起参数' : '参数设置'}
          </button>
        </div>
        {showMobileParams && (
          <div className={styles.mobileParams}>
            <ParamsPanel {...paramsProps} />
          </div>
        )}

        <div className={styles.wrap}>
          <div className={styles.layout}>
            <div className={styles.content}>

              {/* ── Batch task list modal ── */}
              {showBatchList && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.4)' }} onClick={() => setShowBatchList(false)}>
                  <div style={{ background: '#fff', borderRadius: 12, width: '90%', maxWidth: 500, maxHeight: '70vh', overflow: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>历史任务</h3>
                      <button type="button" onClick={() => setShowBatchList(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>×</button>
                    </div>
                    {batchLoading ? <p style={{ textAlign: 'center', color: '#9ca3af' }}>加载中...</p> : batchList.length === 0 ? <p style={{ textAlign: 'center', color: '#9ca3af' }}>暂无历史任务</p> : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {batchList.map(b => {
                          const allSucceeded = b.tasks && Object.keys(b.tasks).length > 0 && Object.values(b.tasks).every(t => t.status === 'succeeded');
                          return (
                          <div key={b.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: batchId === b.id ? '#eff6ff' : '#fff' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {allSucceeded && <span style={{ color: '#16a34a', marginRight: 4 }} title="全部生成成功">&#10003;</span>}
                                {b.name}
                              </p>
                              <p style={{ margin: '2px 0 0', fontSize: 11, color: '#9ca3af' }}>
                                {b.shots?.length || 0} 个分镜 · {new Date(b.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                              <button type="button" onClick={() => restoreBatch(b)}
                                style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#2563eb', border: 'none', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' }}>
                                恢复
                              </button>
                              <button type="button" onClick={() => { if (confirm('确定删除此集合任务？')) deleteBatch(b.id); }}
                                style={{ fontSize: 12, fontWeight: 600, color: '#ef4444', background: 'none', border: '1px solid #ef4444', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' }}>
                                删除
                              </button>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Step 1 ── */}
              <div style={{ marginBottom: 16 }}>
                <p className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  视频需求
                  <button type="button" onClick={() => setShowExamples(v => !v)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: '#0d9488', fontSize: 13, fontWeight: 500 }}>
                    示例
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 12, height: 12, color: '#9ca3af', transform: showExamples ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
                      <path d="m6 9 6 6 6-6"/>
                    </svg>
                  </button>
                  <button type="button" onClick={() => setShowAiInput(v => !v)}
                    style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #6b7280', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                    AI辅助填写
                  </button>
                  <span style={{ flex: 1 }} />
                  {(initResult || shots.length > 0) && (
                    <>
                      <button type="button" onClick={async () => {
                        if (batchId) {
                          try { await api.put(`/batch/${batchId}`, getBatchPayload()); alert('已保存'); } catch { alert('保存失败'); }
                        } else {
                          const autoName = (script.trim() || subtitleInput.trim()).slice(0, 30) || '未命名任务';
                          try {
                            const batch = await api.post<BatchTask>('/batch', { ...getBatchPayload(), name: autoName, init_result: initResult });
                            setBatchId(batch.id); setBatchName(autoName); alert('已保存');
                          } catch { alert('保存失败'); }
                        }
                      }} className={styles.resetBtn} style={{ color: '#2563eb', borderColor: '#2563eb' }} title="保存当前集合任务">保存草稿</button>
                      <button type="button" onClick={handleReset} className={styles.resetBtn} title="新建集合任务">新任务</button>
                    </>
                  )}
                </p>
                  {showAiInput && (
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
                      <input type="text" value={aiTopic} onChange={e => setAiTopic(e.target.value)}
                        placeholder="输入想要生成视频的简要说明、关键词"
                        style={{ flex: 1, fontSize: 12, padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6, outline: 'none' }} />
                      <button type="button" disabled={aiScriptLoading} onClick={async () => {
                        setAiScriptLoading(true);
                        try {
                          const res = await api.post<{ script: string }>('/voiceover/generate-script', { topic: aiTopic.trim() });
                          if (res.script) { setScript(res.script); setInitResult(null); setShots([]); setMergedVideoUrl(null); setShowAiInput(false); }
                        } catch (e: any) { console.warn('AI生成失败:', e); }
                        finally { setAiScriptLoading(false); }
                      }}
                        style={{ fontSize: 12, padding: '5px 12px', border: '1px solid #2563eb', borderRadius: 6, background: '#eff6ff', cursor: aiScriptLoading ? 'not-allowed' : 'pointer', color: '#2563eb', whiteSpace: 'nowrap' }}>
                        {aiScriptLoading ? '生成中…' : '生成'}
                      </button>
                    </div>
                  )}
                  {showExamples && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {EXAMPLE_SCRIPTS.map((ex, i) => (
                        <button key={i} type="button"
                          onClick={() => { setScript(ex.text); setInitResult(null); setShots([]); setMergedVideoUrl(null); setShowExamples(false); }}
                          className={`${styles.chip} ${styles.chipPill} ${script === ex.text ? styles.chipPillActive : ''}`}>
                          {ex.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    {script.trim() && (
                      <button type="button" onClick={() => { setScript(''); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                        style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                        清空
                      </button>
                    )}
                    <textarea rows={4} value={script}
                      onChange={e => { setScript(e.target.value); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                      placeholder="描述你想要的视频内容…"
                      className={styles.textarea} style={{ fontFamily: 'inherit', fontSize: 13, border: '2px solid #000' }} />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, marginTop: 14, flexWrap: 'wrap' }}>
                    <p className={styles.cardTitle} style={{ margin: 0 }}>字幕 <span style={{ position: 'relative', display: 'inline-block' }}>
                        <span onClick={() => setShowSubtitleTip(v => !v)} style={{ fontSize: 11, fontWeight: 400, textDecoration: 'underline', cursor: 'pointer', color: '#6b7280' }}>说明</span>
                        {showSubtitleTip && (
                          <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, background: '#1e293b', color: '#f1f5f9', fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8, width: 260, zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'normal' }}>
                            如果字幕输入内容，那么生成视频的字幕严格按照字幕内容来生成，如果字幕内容为空，系统会根据视频需求来自动生成合适的字幕
                            <span onClick={() => setShowSubtitleTip(false)} style={{ display: 'block', textAlign: 'right', marginTop: 6, cursor: 'pointer', color: '#94a3b8', fontSize: 11 }}>关闭</span>
                          </div>
                        )}
                      </span></p>
                    <select value={voice} onChange={e => setVoice(e.target.value)}
                      style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #111827', background: '#fff', color: '#374151', cursor: 'pointer', width: 110 }}>
                      {AZURE_VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                    <button type="button" onClick={handleRegenTTS} disabled={ttsLoading || !subtitleInput.trim()}
                      style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #111827', borderRadius: 5, background: ttsLoading ? '#f3f4f6' : '#fff', cursor: (ttsLoading || !subtitleInput.trim()) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', color: '#374151' }}>
                      {ttsLoading ? '生成中…' : audioUrl ? '重新生成' : '生成配音'}
                    </button>
                    {audioUrl && (
                      <audio controls src={audioUrl} style={{ height: 28, flex: 1, minWidth: 120 }} />
                    )}
                  </div>
                  <div style={{ position: 'relative', marginBottom: 10 }}>
                    {subtitleInput.trim() && (
                      <button type="button" onClick={() => { setSubtitleInput(''); setInitResult(null); setShots([]); setMergedVideoUrl(null); }}
                        style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
                        清空
                      </button>
                    )}
                    <textarea rows={3} value={subtitleInput}
                      onChange={e => { setSubtitleInput(e.target.value); setAudioUrl(null); }}
                      placeholder="输入字幕文本，将按分镜拆分并在视频中显示…"
                      className={styles.textarea} style={{ fontFamily: 'inherit', fontSize: 13, border: '2px solid #000' }} />
                  </div>

                  {/* 三列独立 box：真人头像 | 虚拟人像 | 备用人像库 */}
                  <p className={styles.cardTitle} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, marginTop: 20 }}>
                    参考素材
                    <span style={{ position: 'relative', display: 'inline-block' }}>
                      <button type="button" onClick={() => setShowMediaTip(v => !v)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400, textDecoration: 'underline' }}>说明</span>
                      </button>
                      {showMediaTip && (
                        <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, background: '#1e293b', color: '#f1f5f9', fontSize: 12, lineHeight: 1.6, padding: '10px 12px', borderRadius: 8, width: 260, zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'normal' }}>
                          图片最多 8 张 · 视频最多 4 条 · 音频最多 4 条。上传素材后，AI 会根据素材内容和风格生成匹配的视频画面。
                          <span onClick={() => setShowMediaTip(false)} style={{ display: 'block', textAlign: 'right', marginTop: 6, cursor: 'pointer', color: '#94a3b8', fontSize: 11 }}>关闭</span>
                        </div>
                      )}
                    </span>
                    <button type="button" onClick={() => mediaInputRef.current?.click()}
                      style={{ fontSize: 13, padding: '4px 8px', border: '1px solid #6b7280', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151' }}>
                      上传素材(图像|音频|视频)
                    </button>
                    <input ref={mediaInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: 'none' }}
                      onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                  </p>
                  <MediaPanel items={mediaItems} onAddFiles={addFiles} onRemove={removeMediaItem} uploadError={uploadError} />
                  <div className={styles.resourceGrid} style={{ marginBottom: 14 }}>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fff' }}>
                      <AssetLibrary
                        key={`real-${resetKey}`}
                        groupType="LivenessFace" title="真人头像" color="#374151"
                        selectedIds={mediaItems.filter(m => m.url?.startsWith('asset://remote:')).map(m => m.url!.replace('asset://remote:', ''))}
                        onAdd={(assetId, label, previewUrl) => {
                          if (mediaItems.filter(m => m.mediaType === 'image').length >= MEDIA_LIMITS.image) return;
                          setMediaItems(prev => [...prev, { mediaType: 'image', url: `asset://remote:${assetId}`, name: label, previewUrl }]);
                        }}
                        onRemove={assetId => setMediaItems(prev => prev.filter(m => m.url !== `asset://remote:${assetId}`))}
                      />
                    </div>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fff' }}>
                      <AssetLibrary
                        key={`virtual-${resetKey}`}
                        groupType="AIGC" title="虚拟人像" color="#374151"
                        selectedIds={mediaItems.filter(m => m.url?.startsWith('asset://remote:')).map(m => m.url!.replace('asset://remote:', ''))}
                        onAdd={(assetId, label, previewUrl) => {
                          if (mediaItems.filter(m => m.mediaType === 'image').length >= MEDIA_LIMITS.image) return;
                          setMediaItems(prev => [...prev, { mediaType: 'image', url: `asset://remote:${assetId}`, name: label, previewUrl }]);
                        }}
                        onRemove={assetId => setMediaItems(prev => prev.filter(m => m.url !== `asset://remote:${assetId}`))}
                      />
                    </div>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fff' }}>
                      <div onClick={() => setAvatarExpanded(v => !v)}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>备用人像库</span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{avatarExpanded ? '▼' : '▶'} {avatars.length} 人</span>
                      </div>
                      {avatarExpanded && (
                        <>
                          <input type="text" placeholder="搜索职业、国籍、年龄…" value={avatarSearch}
                            onChange={e => setAvatarSearch(e.target.value)}
                            style={{ width: '100%', padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12, marginTop: 8, marginBottom: 8, boxSizing: 'border-box' }} />
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 5, maxHeight: 200, overflowY: 'auto' }}>
                            {(avatarSearch.trim() ? avatars.filter(a => a.label.includes(avatarSearch.trim())) : avatars).slice(0, 80).map(av => {
                              const selected = mediaItems.some(m => m.url === `asset://${av.assetId}`);
                              return (
                                <div key={av.assetId}
                                  onClick={() => {
                                    if (selected) { setMediaItems(prev => prev.filter(m => m.url !== `asset://${av.assetId}`)); }
                                    else { if (mediaItems.filter(m => m.mediaType === 'image').length >= MEDIA_LIMITS.image) return; setMediaItems(prev => [...prev, { mediaType: 'image', url: `asset://${av.assetId}`, name: av.label, previewUrl: av.thumb }]); }
                                  }}
                                  style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', border: selected ? '2px solid #7c3aed' : '1px solid #e5e7eb', aspectRatio: '3/4', background: '#f8fafc' }}>
                                  <img src={av.thumb} alt={av.label} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,.6))', padding: '10px 3px 2px', fontSize: 9, color: '#fff', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {av.label.replace(/_/g, ' ')}
                                  </div>
                                  {selected && <div style={{ position: 'absolute', top: 3, right: 3 }}><span style={{ background: '#7c3aed', color: '#fff', borderRadius: '50%', padding: '1px 3px', fontSize: 9 }}>✓</span></div>}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 主体定义 */}
                  <div style={{ marginBottom: 14, display: 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <button type="button" onClick={handleAnalyzeSubjects}
                        disabled={analyzingSubjects || mediaItems.filter(m => m.mediaType === 'image' && !m.uploading).length === 0}
                        style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1.5px solid #0d9488', background: '#f0fdfa', color: '#0d9488', cursor: 'pointer', fontWeight: 500 }}>
                        {analyzingSubjects ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className={styles.spinner} style={{ width: 10, height: 10 }} /> 分析中…
                          </span>
                        ) : '主体定义'}
                      </button>
                      <span style={{ fontSize: 11, color: '#9ca3af', display: 'none' }}>AI 分析素材中的主体，用于后续分镜引用</span>
                    </div>
                    {subjectError && <div className={styles.errInline} style={{ marginBottom: 8 }}>{subjectError}</div>}
                    {subjectDefs && (
                      <textarea
                        className={styles.textarea}
                        value={subjectDefs}
                        onChange={e => setSubjectDefs(e.target.value)}
                        rows={Math.min(8, subjectDefs.split('\n').length + 1)}
                        style={{ fontSize: 12, fontFamily: 'inherit', background: '#f0fdfa', borderColor: '#99f6e4' }}
                        placeholder="主体定义将显示在这里，可手动编辑..."
                      />
                    )}
                  </div>


                  {initError && <div className={styles.errorBox}>{initError}</div>}

                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button type="button" onClick={handleInit} disabled={initing || (!script.trim() && !subtitleInput.trim()) || anyUploading}
                    className={styles.btnPrimary} style={{ padding: '7px 24px', width: 'auto' }}>
                    {initing ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className={styles.spinner} style={{ borderColor: '#5eead4', borderTopColor: '#fff' }} />
                        分镜进行中...
                      </span>
                    ) : anyUploading ? '素材上传中，请等待…' : initResult ? '重新生成分镜脚本' : '一键生成分镜'}
                  </button>
                  </div>
              </div>

              {/* ── Step 2 ── */}
              {initResult && shots.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 0', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>
                      {shots.length}个分镜 · 视频{Math.round(shots.reduce((a, s) => a + s.duration, 0))}秒{audioDuration > 0 ? ` · 音频${Math.round(audioDuration)}秒` : ''}
                    </span>
                    {succeededCount > 0 && <span style={{ fontSize: 13, color: '#16a34a' }}>{succeededCount}已生成</span>}
                    {ttsLoading && <span style={{ fontSize: 12, color: '#2563eb' }}>语音生成中…</span>}
                  </div>

                  <div style={{ padding: '0 0 16px' }}>
                    {shots.map((shot, idx) => {
                      const task = tasks[idx];
                      return (
                        <Fragment key={idx}>
                          <div className={styles.shotCard} style={idx === 0 ? { marginTop: 12 } : undefined}>
                            <div className={styles.shotHead}>
                              <div className={styles.shotInfo}>
                                <span className={styles.shotNum}>分镜{shot.shot_number}</span>
                                <div className={styles.shotMeta}>
                                  <p className={styles.shotTitle}>{shot.title}</p>
                                  <p className={styles.shotDesc}>{shot.description}</p>
                                </div>
                              </div>
                              <div className={styles.shotBtns}>
                                <button type="button" onClick={() => submitShot(idx)}
                                  disabled={task?.submitting || (task?.taskId != null && !TERMINAL.has(task?.status || ''))}
                                  className={styles.btnShotGen}>
                                  {task?.submitting ? '提交中…' : (task?.taskId && !TERMINAL.has(task.status)) ? '生成中' : task?.status === 'succeeded' ? '重新生成' : `生成视频${idx + 1}`}
                                </button>
                                {task && task.status && <StatusBadge status={task.status} />}
                              </div>
                            </div>

                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0', alignItems: 'center' }}>
                              {shot.mood && <span className={styles.moodTag}>{shot.mood}</span>}
                              {shot.camera_movement && <span className={styles.movTag}>{shot.camera_movement}</span>}
                              <span className={`${styles.movTag} ${styles.movTagTtsOk}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <input type="number" min={4} max={15} step={1} value={shot.duration}
                                  onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], duration: Math.max(4, Math.min(15, Number(e.target.value) || 5)) }; setShots(u); }}
                                  style={{ width: 36, border: 'none', background: 'transparent', fontSize: 12, fontWeight: 600, textAlign: 'center', color: 'inherit', outline: 'none' }} />s
                              </span>
                              {shot.subjects && shot.subjects.length > 0 && shot.subjects.map((subj, si) => (
                                <span key={si} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 9999, border: '1px solid #c4b5fd', padding: '2px 8px', fontSize: 11, background: '#f5f3ff', color: '#7c3aed' }}>
                                  {subj}
                                </span>
                              ))}
                            </div>


                            <div style={{ marginBottom: 8 }}>
                              <span className={styles.fieldLabel}>分镜{idx + 1}场景描述（可编辑）</span>
                              <textarea rows={4} value={shot.prompt}
                                onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], prompt: e.target.value }; setShots(u); }}
                                className={styles.textarea} />
                            </div>

                            <div style={{ marginBottom: 8 }}>
                              <span className={styles.fieldLabel}>分镜{idx + 1}字幕</span>
                              <textarea rows={2} value={shot.subtitle}
                                onChange={e => { const u = [...shots]; u[idx] = { ...u[idx], subtitle: e.target.value }; setShots(u); }}
                                className={styles.textarea} />
                            </div>

                            {task?.error && <p className={styles.errInline} style={{ marginTop: 6 }}>{task.error}</p>}

                            <details className={styles.jsonDetails}>
                              <summary className={styles.fieldLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none', marginBottom: 4 }}>查看提交 JSON</summary>
                              <pre style={{ margin: '6px 0 0', padding: 8, background: '#1e293b', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: 200 }}>
                                {JSON.stringify((() => {
                                  const content: any[] = [{ type: 'text', text: shot.prompt }];
                                  // Maintain upload order — iterate mediaItems directly
                                  mediaItems.filter(m => m.url && !m.uploading).forEach(m => {
                                    const url = m.url!.startsWith('asset://remote:') ? m.url!.replace('asset://remote:', 'asset://') : m.url!;
                                    if (m.mediaType === 'image') {
                                      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
                                    } else if (m.mediaType === 'video') {
                                      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
                                    } else if (m.mediaType === 'audio') {
                                      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
                                    }
                                  });
                                  return {
                                    model,
                                    content,
                                    resolution, ratio,
                                    duration: shot.duration || 8,
                                    seed: batchSeedRef.current,
                                    generate_audio: generateAudio,
                                    watermark,
                                    return_last_frame: returnLastFrame || undefined,
                                    draft: draft || undefined,
                                    service_tier: serviceTier !== 'default' ? serviceTier : undefined,
                                    priority: priority > 0 ? priority : undefined,
                                    tools: webSearch ? [{ type: 'web_search' }] : undefined,
                                  };
                                })(), null, 2)}
                              </pre>
                            </details>

                            {task?.taskId && !TERMINAL.has(task.status) && (
                              <div className={styles.pollingRow}>
                                <span className={styles.pollingText}>
                                  <span className={`${styles.spinner} ${styles.spinnerBlue}`} />生成中，每 10 秒自动查询
                                </span>
                                <button type="button" onClick={() => pollTaskById(idx, task.taskId!)} className={styles.refreshBtn}>立即刷新</button>
                              </div>
                            )}
                            {task?.videoUrl && (
                              <div style={{ marginBottom: 8 }}>
                                <span className={styles.fieldLabel}>预览</span>
                                <VideoThumb src={task.videoUrl} ratio={shot.ratio || ratio} subtitle={shot.subtitle} />
                              </div>
                            )}
                          </div>
                        </Fragment>
                      );
                    })}

                    <div className={styles.shotListActions} style={{ marginTop: 12, marginBottom: 12 }}>
                      <button type="button" onClick={submitAllShots}
                        disabled={succeededCount === shots.length}
                        className={styles.btnSmTeal} style={{ width: '100%' }}>
                        {succeededCount === shots.length ? '全部完成' : '一键生成所有分镜视频'}
                      </button>
                    </div>

                    {/* ── Step 3: Merge ── */}
                    {canMerge && (
                      <div className={styles.mergeBox}>
                        {succeededCount >= 1 && (
                          <>
                            <p className={styles.mergeTitle}>{succeededCount} / {shots.length} 个分镜视频已生成{allDone ? ' — 全部完成！' : ''}</p>
                            <p className={styles.mergeSub}>合并后自动烧录字幕 + 叠加配音</p>
                          </>
                        )}
                        <div className={styles.mergeFooter} style={{ marginTop: 14, justifyContent: 'center' }}>
                          <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                            {succeededCount >= 1 && (
                              <button type="button" onClick={handleMerge} disabled={merging || !canMerge}
                                className={styles.btnSmGreen} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '7px 32px', fontSize: 15, fontWeight: 600, borderRadius: 10 }}>
                                {merging ? <><span className={styles.spinner} style={{ borderColor: '#bbf7d0', borderTopColor: '#16a34a' }} />合并中…</> : mergedVideoUrl ? '重新生成(分镜视频+字幕+配音)' : '分镜合并(分镜视频+字幕+配音)'}
                              </button>
                            )}
                          </div>
                        </div>
                        {mergeError && <p className={styles.errInline} style={{ marginTop: 8 }}>{mergeError}</p>}
                        {mergedVideoUrl && (
                          <div className={styles.mergedResult}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                              <p className={styles.mergedTitle} style={{ margin: 0 }}>最终视频（点击放大）</p>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <a href={mergedVideoUrl} download className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>下载</a>
                                <a href={mergedVideoUrl} target="_blank" rel="noopener noreferrer"
                                  className={`${styles.btnOutline} ${styles.btnOutlineGreen}`} style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>新窗口打开</a>
                              </div>
                            </div>
                            <video src={mergedVideoUrl} muted autoPlay loop className={styles.mergedVideo}
                              style={{ maxWidth: 320, maxHeight: 200, borderRadius: 8, cursor: 'pointer', display: 'block', margin: '0 auto' }}
                              onClick={() => window.open(mergedVideoUrl, '_blank')} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── Desktop sidebar ── */}
            <div className={styles.sidebar}>
              <div style={{ position: 'sticky', top: 64 }}>
                <ParamsPanel {...paramsProps} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
