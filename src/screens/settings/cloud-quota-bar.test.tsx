import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import i18n from '@/i18n';
import { CloudQuotaBar } from './cloud-quota-bar';

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null }));

describe('CloudQuotaBar', () => {
  it('renders an integer percentage accessibility range for a partial positive total', async () => {
    await i18n.changeLanguage('en');
    await render(<CloudQuotaBar quota={{ usedBytes: 1_250_000_000, totalBytes: 2_000_000_000 }} />);
    expect(screen.getByTestId('byos-quota')).toHaveTextContent(i18n.t('settings.cloudLibrary.quota', { used: '1.3', total: '2.0' }));
    expect(screen.getByTestId('byos-quota-progress').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 63 });
    const fill = screen.getByTestId('byos-quota-progress').children[0];
    if (typeof fill === 'string') throw new Error('expected fill view');
    expect(StyleSheet.flatten(fill.props.style).width).toBe('62.5%');
  });

  it('clamps the fill and the accessibility percentage at both boundaries', async () => {
    await i18n.changeLanguage('en');
    // Over capacity (used > total): both the width and the a11y value clamp to 100.
    const view = await render(<CloudQuotaBar quota={{ usedBytes: 3_000_000_000, totalBytes: 2_000_000_000 }} />);
    let progress = screen.getByTestId('byos-quota-progress');
    expect(progress.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 100 });
    let fill = progress.children[0];
    if (typeof fill === 'string') throw new Error('expected fill view');
    expect(StyleSheet.flatten(fill.props.style).width).toBe('100%');
    // Defensive: a negative reported usage never produces a negative width or value.
    await view.rerender(<CloudQuotaBar quota={{ usedBytes: -500_000_000, totalBytes: 2_000_000_000 }} />);
    progress = screen.getByTestId('byos-quota-progress');
    expect(progress.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 0 });
    fill = progress.children[0];
    if (typeof fill === 'string') throw new Error('expected fill view');
    expect(StyleSheet.flatten(fill.props.style).width).toBe('0%');
  });

  it('renders used-only and zero-total states without a divide-by-zero value', async () => {
    await i18n.changeLanguage('en');
    const view = await render(<CloudQuotaBar quota={{ usedBytes: 1_000_000_000, totalBytes: null }} />);
    expect(screen.getByTestId('byos-quota')).toHaveTextContent(i18n.t('settings.cloudLibrary.quotaUsedOnly', { used: '1.0' }));
    expect(screen.queryByTestId('byos-quota-progress')).toBeNull();
    await view.rerender(<CloudQuotaBar quota={{ usedBytes: 0, totalBytes: 0 }} />);
    expect(screen.getByTestId('byos-quota')).toHaveTextContent(i18n.t('settings.cloudLibrary.quota', { used: '0.0', total: '0.0' }));
    expect(screen.getByTestId('byos-quota')).not.toHaveTextContent(/NaN|Infinity/);
    const progress = screen.getByTestId('byos-quota-progress');
    expect(progress.props.accessibilityValue).toBeUndefined();
    const fill = progress.children[0];
    if (typeof fill === 'string') throw new Error('expected fill view');
    expect(StyleSheet.flatten(fill.props.style).width).toBe('0%');
  });
});
