export const discordSnowflakePattern = /^\d{17,20}$/;

export type DiscordEnvValidationInput = {
  env: NodeJS.ProcessEnv;
  applicationIdEnv?: string;
  guildIdEnv?: string;
  approvalChannelIdEnv?: string;
  ownerUserIdEnv?: string;
  allowedUserIdsEnv?: string;
};

export type DiscordEnvValidationResult = {
  invalid_env: string[];
  gateway_invalid_env: string[];
  live_invalid_env: string[];
};

export function isDiscordSnowflake(value: string | undefined): boolean {
  return discordSnowflakePattern.test((value ?? "").trim());
}

export function parseDiscordIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateDiscordEnvValues(
  input: DiscordEnvValidationInput
): DiscordEnvValidationResult {
  const gatewayEnvNames = [
    input.applicationIdEnv,
    input.guildIdEnv,
    input.approvalChannelIdEnv,
    input.ownerUserIdEnv
  ].filter((name): name is string => name !== undefined);
  const gatewayInvalidEnv = uniqueStrings(
    gatewayEnvNames.filter((name) => isInvalidSnowflakeEnv(input.env, name))
  );

  const liveInvalidEnv = [...gatewayInvalidEnv];
  const allowedUserIdsEnv = input.allowedUserIdsEnv;
  if (
    allowedUserIdsEnv !== undefined &&
    hasEnvValue(input.env, allowedUserIdsEnv) &&
    parseDiscordIdList(input.env[allowedUserIdsEnv]).some(
      (id) => !isDiscordSnowflake(id)
    )
  ) {
    liveInvalidEnv.push(allowedUserIdsEnv);
  }

  return {
    invalid_env: uniqueStrings(liveInvalidEnv),
    gateway_invalid_env: gatewayInvalidEnv,
    live_invalid_env: uniqueStrings(liveInvalidEnv)
  };
}

function isInvalidSnowflakeEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return hasEnvValue(env, name) && !isDiscordSnowflake(env[name]);
}

function hasEnvValue(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
