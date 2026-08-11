'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import styles from './page.module.css';

interface AssetGroup {
  Id: string;
  Name: string | null;
  ProjectName: string;
  CreateTime: number;
  GroupType: 'AIGC' | 'LivenessFace';
}

interface Asset {
  Id: string;
  Name: string | null;
  AssetType: string;
  Status: string;
  PreviewUrl?: string;
  URL?: string;
  FileUrl?: string;
  GroupId?: string;
  CreateTime?: number;
}

export type AssetTab = 'real' | 'virtual';

export function AssetsPanel({ tab }: { tab: AssetTab }) {
  const [groups, setGroups] = useState<AssetGroup[]>([]);
  const [assets, setAssets] = useState<Record<string, Asset[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  const [validateSession, setValidateSession] = useState<{ sessionId: string; h5Link: string } | null>(null);
  const [validatePolling, setValidatePolling] = useState(false);

  const groupType = tab === 'real' ? 'LivenessFace' : 'AIGC';

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<{ Items: AssetGroup[]; TotalCount: number }>(`/assets/groups?groupType=${groupType}`);
      const items = res.Items || [];
      setGroups(items);
      setExpandedGroups(new Set(items.map(g => g.Id)));
      items.forEach(g => loadAssets(g.Id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [groupType]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  async function loadAssets(groupId: string) {
    try {
      const res = await api.get<{ Items: Asset[] }>(`/assets/groups/${groupId}/assets`);
      const items = res.Items || [];
      const enriched = await Promise.all(items.map(async (item) => {
        if (item.AssetType === 'Image') {
          try {
            const detail = await api.get<{ URL?: string; Status?: string }>(`/assets/item/${item.Id}`);
            return { ...item, URL: detail.URL || undefined, Status: detail.Status || item.Status };
          } catch { return item; }
        }
        return item;
      }));
      setAssets(prev => ({ ...prev, [groupId]: enriched }));
    } catch {}
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
        if (!assets[groupId]) loadAssets(groupId);
      }
      return next;
    });
  }

  async function createGroup() {
    if (!newGroupName.trim() && tab === 'virtual') return;
    setCreating(true);
    try {
      if (tab === 'virtual') {
        await api.post('/assets/groups', { name: newGroupName.trim(), groupType: 'AIGC' });
        setNewGroupName('');
        await loadGroups();
      } else {
        const res = await api.post<{ session_id: string; h5_link: string }>('/assets/visual-validate/start');
        setValidateSession({ sessionId: res.session_id, h5Link: res.h5_link });
        setValidatePolling(true);
        pollValidate(res.session_id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function pollValidate(sessionId: string) {
    const interval = setInterval(async () => {
      try {
        const res = await api.get<{ status: string; group_id?: string }>(`/assets/visual-validate/${sessionId}`);
        if (res.group_id || res.status === 'completed' || res.status === 'succeeded') {
          clearInterval(interval);
          setValidateSession(null);
          setValidatePolling(false);
          await loadGroups();
        } else if (res.status === 'failed' || res.status === 'expired') {
          clearInterval(interval);
          setValidateSession(null);
          setValidatePolling(false);
          setError('验证失败或超时，请重试');
        }
      } catch {
        clearInterval(interval);
        setValidatePolling(false);
      }
    }, 3000);
  }

  async function deleteGroup(groupId: string) {
    if (!confirm('确定删除该资源组？组内所有资源将被删除。')) return;
    try {
      await api.del(`/assets/groups/${groupId}`);
      await loadGroups();
    } catch {}
  }

  async function deleteAsset(assetId: string, groupId: string) {
    if (!confirm('确定删除该资源？')) return;
    try {
      await api.del(`/assets/item/${assetId}`);
      await loadAssets(groupId);
    } catch {}
  }

  async function uploadAssetToGroup(groupId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const headers: Record<string, string> = {};
      const token = getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: form, headers });
      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) throw new Error(uploadJson.error);

      const fileUrl = uploadJson.data.url;
      const assetType = file.type.startsWith('video/') ? 'Video'
                      : file.type.startsWith('audio/') ? 'Audio'
                      : 'Image';

      await api.post(`/assets/groups/${groupId}/assets`, {
        fileUrl,
        assetType,
        name: file.name,
      });
      await loadAssets(groupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.desc}>
          {tab === 'virtual' ? (
            <>
              <p>虚拟人像资源，无需活体验证，直接创建组并上传素材。</p>
              <p className={styles.warn}>上传素材必须合法拥有使用权，不得与真实人物肖像相似。</p>
            </>
          ) : (
            <>
              <p>真人资源需要通过 H5 活体验证（人脸识别）创建资源组。</p>
              <p>验证通过后可在组内上传图片/视频/音频，生成视频时通过 <code>asset://</code> 引用。</p>
            </>
          )}
        </div>

        <div className={styles.createRow}>
          {tab === 'virtual' && (
            <input type="text" placeholder="资源组名称" value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)} className={styles.input} />
          )}
          <button onClick={createGroup} disabled={creating || (tab === 'virtual' && !newGroupName.trim())}
            className={styles.btnPrimary}>
            {creating ? '创建中...' : tab === 'virtual' ? '创建虚拟人像组' : '添加真人（H5 验证）'}
          </button>
          <button onClick={loadGroups} disabled={loading} className={styles.btnGhost}>刷新</button>
        </div>

        {validateSession && (
          <div className={styles.validateBox}>
            <h3>真人验证</h3>
            <p>请在手机端完成活体验证：</p>
            <div className={styles.qrWrap}>
              <img src={`/api/assets/visual-validate/${validateSession.sessionId}/qr`} alt="扫码验证" />
            </div>
            <a href={validateSession.h5Link} target="_blank" rel="noopener noreferrer" className={styles.btnGhost}>
              在当前设备打开验证
            </a>
            {validatePolling && <p className={styles.polling}>等待验证完成...</p>}
          </div>
        )}

        {error && <div className={styles.errorBox}>{error}</div>}

        {loading && groups.length === 0 && <p className={styles.muted}>加载中...</p>}

        <div className={styles.groupList}>
          {groups.map(group => (
            <div key={group.Id} className={styles.groupCard}>
              <div className={styles.groupHead} onClick={() => toggleGroup(group.Id)}>
                <div className={styles.groupInfo}>
                  <span className={styles.groupName}>{group.Name || '(未命名)'}</span>
                  <span className={styles.groupId}>{group.Id}</span>
                  <span className={styles.groupTime}>
                    {new Date(group.CreateTime * 1000).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <div className={styles.groupActions}>
                  <button onClick={e => { e.stopPropagation(); deleteGroup(group.Id); }}
                    className={styles.btnDanger}>删除</button>
                  <span className={styles.expandIcon}>{expandedGroups.has(group.Id) ? '▼' : '▶'}</span>
                </div>
              </div>

              {expandedGroups.has(group.Id) && (
                <div className={styles.groupBody}>
                  <div className={styles.uploadRow}>
                    <label className={styles.uploadBtn}>
                      上传素材
                      <input type="file" accept="image/*,video/*,audio/*" style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadAssetToGroup(group.Id, f); e.target.value = ''; }} />
                    </label>
                    <span className={styles.muted}>支持图片、视频、音频</span>
                  </div>

                  {(assets[group.Id] || []).length === 0 && (
                    <p className={styles.muted}>暂无资源，点击上方按钮上传</p>
                  )}

                  <div className={styles.assetGrid}>
                    {(assets[group.Id] || []).map(asset => (
                      <div key={asset.Id} className={styles.assetCard}>
                        {asset.AssetType === 'Image' && (asset.URL || asset.PreviewUrl) && (
                          <img src={asset.URL || asset.PreviewUrl} alt="" className={styles.assetThumb} />
                        )}
                        <div className={styles.assetInfo}>
                          <span className={styles.assetName}>{asset.Name || asset.Id}</span>
                          <span className={styles.assetType}>{asset.AssetType} · {asset.Status}</span>
                          <code className={styles.assetUri}>asset://{asset.Id}</code>
                        </div>
                        <button onClick={() => deleteAsset(asset.Id, group.Id)}
                          className={styles.btnDangerSm}>x</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}

          {!loading && groups.length === 0 && (
            <p className={styles.muted}>暂无资源组，点击上方按钮创建</p>
          )}
        </div>
      </main>
    </div>
  );
}

