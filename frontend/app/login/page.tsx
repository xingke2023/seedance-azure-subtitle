'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setTokens } from '@/lib/auth'
import styles from './page.module.css'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const body = mode === 'login'
        ? { identifier, password }
        : { username: identifier, password }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || (mode === 'login' ? '登录失败' : '注册失败'))
        return
      }
      const data = json.data
      if (data.accessToken) {
        setTokens(data.accessToken, data.refreshToken)
        router.push('/voiceover-v3')
      } else {
        setError('返回数据异常')
      }
    } catch (err: any) {
      setError(err.message || '网络错误')
    } finally {
      setLoading(false)
    }
  }

  function handleWeChatLogin() {
    const redirectUri = `${window.location.origin}/oauth/callback`
    window.location.href = `/api/auth/wechat?redirect_uri=${encodeURIComponent(redirectUri)}`
  }

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* Left: branding */}
        <div className={styles.brand}>
          <div className={styles.brandInner}>
            <h1 className={styles.brandTitle}>盈信视频生成平台</h1>
            <p className={styles.brandDesc}>v0.2</p>
            <ul className={styles.features}>
              <li>智能分镜脚本生成</li>
              <li>多音色 TTS 配音</li>
              <li>字幕自动烧录</li>
              <li>批量视频合成</li>
            </ul>
          </div>
        </div>

        {/* Right: form */}
        <div className={styles.formWrap}>
          <div className={styles.card}>
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
                onClick={() => { setMode('login'); setError('') }}
              >
                登录
              </button>
              <button
                className={`${styles.tab} ${mode === 'register' ? styles.tabActive : ''}`}
                onClick={() => { setMode('register'); setError('') }}
              >
                注册
              </button>
            </div>

            <form onSubmit={handleSubmit} className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>
                  {mode === 'login' ? '用户名或邮箱' : '用户名'}
                </label>
                <input
                  type="text"
                  placeholder={mode === 'login' ? '请输入用户名或邮箱' : '请输入用户名'}
                  value={identifier}
                  onChange={e => setIdentifier(e.target.value)}
                  className={styles.input}
                  required
                  autoComplete="username"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>密码</label>
                <input
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={styles.input}
                  required
                  autoComplete="current-password"
                />
              </div>

              {error && <div className={styles.error}>{error}</div>}

              <button type="submit" className={styles.btnPrimary} disabled={loading}>
                {loading ? (mode === 'login' ? '登录中…' : '注册中…') : (mode === 'login' ? '登录' : '注册')}
              </button>
            </form>

            <div className={styles.divider}>
              <span className={styles.dividerText}>其他方式</span>
            </div>

            <button onClick={handleWeChatLogin} className={styles.btnWechat}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.127 6.127 0 0 1-.255-1.744c0-3.61 3.428-6.545 7.665-6.545.258 0 .507.022.76.042C16.738 4.964 13.05 2.188 8.691 2.188zm-2.6 4.408c.56 0 1.016.455 1.016 1.016s-.455 1.016-1.016 1.016S5.076 8.172 5.076 7.612s.455-1.016 1.015-1.016zm5.09 0c.56 0 1.016.455 1.016 1.016s-.455 1.016-1.016 1.016-1.016-.455-1.016-1.016.456-1.016 1.016-1.016zm4.71 4.126c-3.697 0-6.696 2.57-6.696 5.738 0 3.167 2.999 5.738 6.696 5.738.74 0 1.455-.108 2.123-.3a.724.724 0 0 1 .6.082l1.43.839a.27.27 0 0 0 .14.044c.133 0 .244-.112.244-.249a.56.56 0 0 0-.04-.178l-.294-1.11a.5.5 0 0 1 .178-.56c1.555-1.146 2.549-2.848 2.549-4.306 0-3.167-3-5.738-6.93-5.738zm-2.478 3.387c.468 0 .847.38.847.847s-.38.847-.847.847a.845.845 0 0 1-.847-.847.85.85 0 0 1 .847-.847zm4.955 0c.468 0 .847.38.847.847s-.38.847-.847.847a.845.845 0 0 1-.847-.847.85.85 0 0 1 .847-.847z"/>
              </svg>
              微信扫码登录
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
