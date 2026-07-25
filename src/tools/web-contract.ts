export const WEB_SEARCH_QUERY_MAX_LENGTH = 500;
export const WEB_SEARCH_QUERY_PATTERN =
  `^\\s*\\S(?:[\\s\\S]{0,${WEB_SEARCH_QUERY_MAX_LENGTH - 2}}\\S)?\\s*$`;
export const WEB_SEARCH_RESULT_LIMIT_MAX = 10;
export const WEB_SEARCH_RESULT_LIMIT_DEFAULT = 10;
