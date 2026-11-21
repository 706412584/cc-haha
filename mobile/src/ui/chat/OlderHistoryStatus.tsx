import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { Spinner, useColors } from '../kit'

/**
 * 消息流顶部的往前翻状态。平时离顶部一屏半就自动加载，滑到这里一般已经在转圈；
 * 只有没连上、加载失败或自动加载暂停时才需要点。各状态同高，切换时内容不跳。
 */
export function OlderHistoryStatus({
  loading,
  failed,
  ready,
  onLoad,
  loadingAll = false,
  onLoadAll,
  onCancel,
}: {
  loading: boolean
  failed: boolean
  ready: boolean
  onLoad(): void
  loadingAll?: boolean
  onLoadAll?(): void
  onCancel?(): void
}) {
  const colors = useColors()
  const label = loadingAll ? '正在加载全部消息' : loading
    ? '正在加载更早的消息'
    : !ready
      ? '连上电脑后继续加载'
      : failed
        ? '没加载出来，点按重试'
        : '加载更早的消息'
  const disabled = loading || !ready
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      hitSlop={8}
      onPress={onLoad}
      style={({ pressed }) => ({
        alignSelf: 'center',
        height: 44,
        justifyContent: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        opacity: pressed ? 0.5 : 1,
      })}
    >
      {loading ? <Spinner size={14} /> : null}
      <Text style={{ fontSize: 14, color: disabled ? colors.ink3 : colors.ink2 }}>{label}</Text>
    </Pressable>
    {ready && (loadingAll ? onCancel : !loading && onLoadAll) ? (
      <Pressable accessibilityRole="button" accessibilityLabel={loadingAll ? '取消加载全部' : '加载全部消息'} onPress={loadingAll ? onCancel : onLoadAll} style={{ paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ fontSize: 14, color: colors.ink2 }}>{loadingAll ? '取消' : '加载全部消息'}</Text>
      </Pressable>
    ) : null}
    </View>
  )
}
