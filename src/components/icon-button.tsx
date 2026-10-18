import type { ComponentRef, ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { PressableProps } from 'react-native';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type IconButtonProps = Omit<
  PressableProps,
  'accessibilityLabel' | 'accessibilityRole' | 'children' | 'style'
> & {
  label: string;
  children: ReactNode;
  hint?: string;
  tooltip?: string;
  tone?: 'neutral' | 'danger' | 'save';
  size?: number;
};

type TooltipPlacementInput = {
  anchorX: number;
  anchorY: number;
  anchorWidth: number;
  anchorHeight: number;
  tooltipWidth: number;
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

const TOOLTIP_GAP = metrics.spacing.small;
const TOOLTIP_EDGE_INSET = metrics.spacing.small;

export function getTooltipPlacement({
  anchorX,
  anchorY,
  anchorWidth,
  anchorHeight,
  tooltipWidth,
  tooltipHeight,
  viewportWidth,
  viewportHeight,
}: TooltipPlacementInput): { left: number; top: number } {
  const maxLeft = Math.max(
    TOOLTIP_EDGE_INSET,
    viewportWidth - TOOLTIP_EDGE_INSET - tooltipWidth,
  );
  const centeredLeft = anchorX + anchorWidth / 2 - tooltipWidth / 2;
  const left = Math.min(maxLeft, Math.max(TOOLTIP_EDGE_INSET, centeredLeft));
  const below = anchorY + anchorHeight + TOOLTIP_GAP;
  const above = anchorY - TOOLTIP_GAP - tooltipHeight;
  const preferredTop = below + tooltipHeight <= viewportHeight ? below : above;
  const top = Math.min(
    Math.max(0, viewportHeight - tooltipHeight),
    Math.max(0, preferredTop),
  );
  return { left, top };
}

export function IconButton({
  label,
  children,
  hint,
  tooltip,
  tone = 'neutral',
  size = metrics.iconButton,
  disabled = false,
  onBlur,
  onFocus,
  onHoverIn,
  onHoverOut,
  ...pressableProps
}: IconButtonProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const viewport = useWindowDimensions();
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [tooltipHeight, setTooltipHeight] = useState(0);
  const isDisabled = disabled === true;
  const buttonSize = Math.max(size, metrics.minimumHitArea);
  const tooltipWidth = Math.min(160, Math.max(0, viewport.width - TOOLTIP_EDGE_INSET * 2));
  const showTooltip = Boolean(tooltip && (focused || hovered));
  const foreground = tone === 'danger'
    ? theme.danger
    : tone === 'save'
      ? theme.save
      : theme.text;
  const measureAnchor = useCallback(() => {
    containerRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, []);
  const placement = getTooltipPlacement({
    anchorX: anchor.x,
    anchorY: anchor.y,
    anchorWidth: anchor.width || buttonSize,
    anchorHeight: anchor.height || buttonSize,
    tooltipWidth,
    tooltipHeight,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  });

  return (
    <View
      ref={containerRef}
      style={{
        position: 'relative',
        width: buttonSize,
        height: buttonSize,
        zIndex: showTooltip ? 1 : 0,
      }}>
      <Pressable
        {...pressableProps}
        role="button"
        aria-label={label}
        accessibilityHint={hint ?? tooltip}
        accessibilityState={{
          ...pressableProps.accessibilityState,
          disabled: isDisabled,
        }}
        disabled={isDisabled}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        onFocus={(event) => {
          setFocused(true);
          measureAnchor();
          onFocus?.(event);
        }}
        onHoverIn={(event) => {
          setHovered(true);
          measureAnchor();
          onHoverIn?.(event);
        }}
        onHoverOut={(event) => {
          setHovered(false);
          onHoverOut?.(event);
        }}
        style={({ pressed }) => ({
          width: buttonSize,
          height: buttonSize,
          minWidth: metrics.minimumHitArea,
          minHeight: metrics.minimumHitArea,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: metrics.radius.circle,
          borderWidth: 1,
          borderColor: tone === 'neutral' ? theme.border : foreground,
          backgroundColor: theme.surface,
          opacity: isDisabled ? 0.38 : pressed ? 0.64 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.96 : 1 }],
        })}>
        {children}
      </Pressable>
      {showTooltip ? (
        <View
          aria-label={`${label}${t('common.hintSuffix')}`}
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            if (height !== tooltipHeight) setTooltipHeight(height);
          }}
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            top: placement.top - anchor.y,
            left: placement.left - anchor.x,
            width: tooltipWidth,
            alignItems: 'center',
            zIndex: 2,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
          }}>
          <Text
            style={{
              maxWidth: tooltipWidth,
              paddingHorizontal: metrics.spacing.small,
              paddingVertical: 4,
              borderRadius: metrics.radius.small,
              backgroundColor: theme.text,
              color: theme.surface,
              fontSize: 12,
              textAlign: 'center',
            }}>
            {tooltip}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
