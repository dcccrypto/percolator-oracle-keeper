export type RpcEndpointValidationOptions = {
  required?: boolean;
  allowInsecureLocalRpc?: boolean;
};

export function isExplicitTrue(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

export function isLocalRpcHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function validateRpcEndpoint(
  name: string,
  rawUrl: string | undefined,
  options: RpcEndpointValidationOptions = {},
): string | null {
  const required = options.required ?? false;
  const allowInsecureLocalRpc = options.allowInsecureLocalRpc ?? false;
  const value = (rawUrl ?? "").trim();

  if (!value) {
    if (required) {
      return `${name} is required but not set or empty. Set ${name} to your Solana RPC endpoint.`;
    }

    return null;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return `${name} is not a valid URL: ${value}`;
  }

  if (url.protocol === "https:") {
    return null;
  }

  if (url.protocol === "http:") {
    if (allowInsecureLocalRpc && isLocalRpcHostname(url.hostname)) {
      return null;
    }

    return (
      `${name} must use secure https protocol. ` +
      "Plaintext http is only allowed for localhost when ALLOW_INSECURE_LOCAL_RPC=true."
    );
  }

  return `${name} must use secure https protocol, got: ${url.protocol}`;
}
