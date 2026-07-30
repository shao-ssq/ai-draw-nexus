import { useEffect, useRef } from 'react'

/**
 * 打字机效果：循环演示一段段示例文案，逐字输入、停留后清空、进入下一条。
 * 用户交互后调用 stop() 即停止演示。
 *
 * @param setValue 设置输入值的函数
 * @param demos    演示文案列表
 * @param options  速度配置
 * @returns { stop } 停止演示
 */
export function useTypewriter(
  setValue: (v: string) => void,
  demos: string[],
  options?: {
    typeInterval?: number       // 打字间隔 ms
    holdAfterComplete?: number  // 写完后停留 ms
    pauseBetween?: number       // 清空后到下一条开始的间隔 ms
  }
) {
  const { typeInterval = 55, holdAfterComplete = 1800, pauseBetween = 300 } = options || {}

  const stoppedRef = useRef(false)
  const indexRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    if (demos.length === 0) return

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      timerRef.current = setTimeout(resolve, ms)
    })

    const run = async () => {
      while (!stoppedRef.current) {
        const text = demos[indexRef.current % demos.length]
        // 逐字输入
        for (let i = 0; i <= text.length; i++) {
          if (stoppedRef.current) return
          setValue(text.slice(0, i))
          await sleep(typeInterval)
        }
        // 写完停留
        await sleep(holdAfterComplete)
        if (stoppedRef.current) return
        // 清空
        setValue('')
        indexRef.current++
        await sleep(pauseBetween)
      }
    }

    run()

    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stop = () => {
    stoppedRef.current = true
    clearTimer()
  }

  return { stop }
}
