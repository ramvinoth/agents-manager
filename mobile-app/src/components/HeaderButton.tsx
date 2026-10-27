import React from "react"
import { TouchableOpacity, type StyleProp, type ViewStyle } from "react-native"
import Icon, { type IconName } from "./Icon"
import { useStyles } from "../lib/styles"

/** One icon control for navigation headers and toolbars: a fixed 32pt box that
 *  centres the glyph (iOS glass enclosure), with a slop that makes the touch
 *  target 52pt. Every header icon goes through here so size, slop and the
 *  disabled look never drift between screens. */
export default function HeaderButton({ icon, color, size = 20, label, testID, onPress, disabled, style, children }: {
  icon?: IconName; color?: string; size?: number; label: string; testID?: string
  onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>; children?: React.ReactNode
}) {
  const styles = useStyles()
  return (
    <TouchableOpacity testID={testID} accessibilityLabel={label} accessibilityRole="button" onPress={onPress} disabled={disabled}
      hitSlop={10} style={[styles.headerBtn, disabled && styles.faded, style]}>
      {children ?? (icon && color ? <Icon name={icon} size={size} color={color} /> : null)}
    </TouchableOpacity>
  )
}
