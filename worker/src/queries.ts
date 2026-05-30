export const QUERY_SEARCH_USER_BY_ACCOUNT = `
  query searchUserByAccount($username: String!) {
    accountProfile(username: $username) {
      id
      username
    }
  }
`;

export const QUERY_ACCOUNT_LEADERBOARD_SEARCH = `
  query accountLeaderboardSearch($limit: Int!, $offset: Int!) {
    accountLeaderboard(limit: $limit, offset: $offset) {
      id
      username
    }
  }
`;

export const QUERY_ACCOUNT_LEADERBOARD_SEARCH_WITH_TOURNAMENT = `
  query accountLeaderboardSearch($limit: Int!, $offset: Int!, $tournament: Int!) {
    accountLeaderboard(limit: $limit, offset: $offset, tournament: $tournament) {
      id
      username
    }
  }
`;

export const QUERY_SEARCH_USER_BY_MODEL = `
  query searchUserByModel($modelName: String!) {
    v3UserProfile(modelName: $modelName) {
      id
      accountName
    }
  }
`;

export const QUERY_GET_USER_MODELS = `
  query getUserModels($username: String!) {
    accountProfile(username: $username) {
      id
      username
      models {
        id
        displayName
        tournament
      }
    }
  }
`;

export const QUERY_GET_USER_MODELS_WITH_TOURNAMENT = `
  query getUserModels($username: String!, $tournament: Int!) {
    accountProfile(username: $username, tournament: $tournament) {
      id
      username
      models {
        id
        displayName
        tournament
      }
    }
  }
`;

export const QUERY_GET_MODEL_BY_NAME = `
  query getModelByName($modelName: String!) {
    v3UserProfile(modelName: $modelName) {
      id
      username
      accountName
      tournament
    }
  }
`;

export const QUERY_GET_MODEL_PERFORMANCE = `
  query getModelPerformance($modelName: String!) {
    v3UserProfile(modelName: $modelName) {
      id
      username
      accountName
      stakeValue
      stakeInfo {
        corrMultiplier
        mmcMultiplier
        tcMultiplier
      }
      roundModelPerformances {
        roundNumber
        roundOpenTime
        roundResolveTime
        roundResolved
        corr
        corr20V2
        corr60
        corrPercentile
        corr20V2Percentile
        mmc
        mmcPercentile
        tc
        tcPercentile
        fnc
        fncV3
        fncV4
        corrMultiplier
        mmcMultiplier
        tcMultiplier
        selectedStakeValue
        payout
        roundPayoutFactor
      }
    }
  }
`;

export const QUERY_GET_SIGNALS_MODEL_BY_NAME = `
  query getSignalsModelByName($modelName: String!) {
    v2SignalsProfile(modelName: $modelName) {
      id
      username
      accountName
      tournament
    }
  }
`;

export const QUERY_GET_SIGNALS_MODEL_PERFORMANCE = `
  query getSignalsModelPerformance($modelName: String!) {
    v2SignalsProfile(modelName: $modelName) {
      id
      username
      accountName
      stakeValue
      stakeInfo {
        corrMultiplier
        mmcMultiplier
        tcMultiplier
      }
      roundModelPerformances {
        roundNumber
        roundOpenTime
        roundResolveTime
        roundResolved
        corr
        corr20V2
        corr60
        corrV4
        mmc
        mmc20d
        tc
        fnc
        fncV3
        fncV4
        corrMultiplier
        mmcMultiplier
        tcMultiplier
        selectedStakeValue
        payout
        roundPayoutFactor
      }
    }
  }
`;

export const QUERY_GET_CRYPTO_MODEL_PERFORMANCE = `
  query getCryptoModelPerformance($modelId: String!, $tournament: Int!, $lastNRounds: Int!) {
    v2RoundModelPerformances(modelId: $modelId, tournament: $tournament, lastNRounds: $lastNRounds) {
      roundNumber
      roundOpenTime
      roundResolveTime
      roundResolved
      submissionScores {
        displayName
        value
      }
    }
  }
`;
