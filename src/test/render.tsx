import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react-native';
import { DefaultTheme, ThemeProvider } from 'expo-router';
import type { ReactElement, ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import {
  AppServicesContextProvider,
  createAppQueryClient,
  type AppServicesContextValue,
} from '@/providers/app-services';

type RenderAppOptions = Omit<RenderOptions, 'wrapper'> & {
  queryClient?: QueryClient;
  services?: AppServicesContextValue;
};

export function renderApp(ui: ReactElement, options: RenderAppOptions = {}) {
  const { queryClient = createAppQueryClient(), services, ...renderOptions } = options;

  function AppTestProviders({ children }: { children: ReactNode }) {
    const content = services ? (
      <AppServicesContextProvider value={services}>{children}</AppServicesContextProvider>
    ) : children;
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider value={DefaultTheme}>
          <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
        </ThemeProvider>
      </GestureHandlerRootView>
    );
  }

  return render(ui, { ...renderOptions, wrapper: AppTestProviders });
}
