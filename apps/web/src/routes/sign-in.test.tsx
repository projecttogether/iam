import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "@/router";
import { stubApi } from "@/test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("the sign-in page", () => {
  it("shows the app with its icon, and ProjectTogether as the organization that makes it", async () => {
    stubApi({
      "GET /auth-config": {
        body: {
          appName: "IAM",
          signedIn: false,
          providerName: "Keycloak",
          oidcEnabled: true,
          devLogin: false,
        },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/login"] }),
      queryClient,
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("link", { name: "Sign in with Keycloak" })).toHaveAttribute(
      "href",
      "/oidc/authenticate/?next=%2F",
    );
    expect(container.querySelector('img[src="/favicon.svg"]')).not.toBeNull();
    expect(screen.getAllByText(/IAM is open source, made by ProjectTogether\./).length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link", { name: /Source code/ })) {
      expect(link).toHaveAttribute("href", "https://github.com/projecttogether/iam");
    }
  });
});
