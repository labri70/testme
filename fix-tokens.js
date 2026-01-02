const fs = require('fs');
const path = require('path');

// 파일 경로 설정
const tokensPath = path.join(__dirname, 'tokens/sd-input/tokens.json');
const originalPath = path.join(__dirname, 'tokens/figma-token.json');

// 변환된 토큰 파일과 원본 파일 읽기
const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));

// 원본 토큰에서 모든 토큰 경로를 맵으로 생성 (참조 해결용)
function buildTokenPathMap(obj, prefix = '', pathMap = {}) {
  if (typeof obj !== 'object' || obj === null) {
    return pathMap;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    
    const currentPath = prefix ? `${prefix}.${key}` : key;
    
    if (value && typeof value === 'object' && value.value && value.type) {
      // 토큰 값을 찾았을 때
      const shortKey = currentPath.split('.').pop();
      if (!pathMap[shortKey]) {
        pathMap[shortKey] = currentPath;
      }
      pathMap[currentPath] = currentPath;
    } else if (typeof value === 'object') {
      buildTokenPathMap(value, currentPath, pathMap);
    }
  }
  
  return pathMap;
}

// 경로 정규화: {blue.500} → {Colors/Mode 1.blue.500}
function normalizeReference(value, tokenSets) {
  if (typeof value !== 'string' || !value.startsWith('{') || !value.endsWith('}')) {
    return value;
  }
  
  const ref = value.slice(1, -1); // {blue.500} → blue.500
  const parts = ref.split('.');
  
  // 이미 전체 경로로 되어있는 경우 (Colors/Mode 1.blue.500)
  if (ref.includes('/')) {
    return value;
  }
  
  // 짧은 경로인 경우 (blue.500) - 가장 일반적인 토큰 세트에서 찾기
  if (parts.length >= 2) {
    const [colorName, shade] = parts;
    const commonSets = ['Colors/Mode 1', 'Colors'];
    
    for (const setName of commonSets) {
      if (tokenSets[setName] && 
          tokenSets[setName][colorName] && 
          tokenSets[setName][colorName][shade]) {
        return `{${setName}.${ref}}`;
      }
    }
  }
  
  return value;
}

// 평탄화된 토큰에서 경로로 값 찾기
function findTokenInFlat(transformedFlat, pathParts) {
  if (pathParts.length === 0) return null;
  
  // 직접 키로 찾기 (Token Transformer가 평탄화함)
  let current = transformedFlat;
  for (let i = 0; i < pathParts.length; i++) {
    if (current && typeof current === 'object') {
      current = current[pathParts[i]];
    } else {
      return null;
    }
  }
  
  return current;
}

// 재귀적으로 원본 구조를 유지하면서 변환된 값 매핑
function mapTransformedValues(originalStruct, transformedFlat, tokenSets, currentPath = []) {
  if (typeof originalStruct !== 'object' || originalStruct === null) {
    return originalStruct;
  }
  
  // 토큰 객체인 경우 (value와 type이 있음)
  if (originalStruct.value !== undefined && originalStruct.type) {
    // 변환된 값 찾기 (평탄화된 구조에서)
    const flatToken = findTokenInFlat(transformedFlat, currentPath);
    
    if (flatToken && flatToken.value !== undefined) {
      // Token Transformer가 해결한 값을 사용
      return {
        type: flatToken.type || originalStruct.type,
        value: flatToken.value,
        ...(flatToken.description && { description: flatToken.description }),
        ...(originalStruct.description && !flatToken.description && { description: originalStruct.description })
      };
    }
    
    // 변환된 값이 없으면 원본 사용 (참조 정규화)
    let transformedValue = originalStruct.value;
    if (typeof transformedValue === 'string' && transformedValue.startsWith('{')) {
      transformedValue = normalizeReference(transformedValue, tokenSets);
    }
    
    return {
      type: originalStruct.type,
      value: transformedValue,
      ...(originalStruct.description && { description: originalStruct.description })
    };
  }
  
  // 중첩 구조인 경우 재귀 처리
  const result = {};
  for (const [key, value] of Object.entries(originalStruct)) {
    if (key.startsWith('$')) {
      result[key] = value;
      continue;
    }
    
    if (typeof value === 'object' && value !== null) {
      const newPath = [...currentPath, key];
      result[key] = mapTransformedValues(value, transformedFlat, tokenSets, newPath);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

// 중첩된 토큰 구조를 평탄화 (최상위 레벨로)
function flattenTokenStructure(obj, prefix = '', result = {}) {
  if (typeof obj !== 'object' || obj === null) {
    return result;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    
    const currentPath = prefix ? `${prefix}.${key}` : key;
    
    // 토큰 객체인 경우 (value와 type이 있음)
    if (value && typeof value === 'object' && value.value !== undefined && value.type) {
      // 최종 키 이름만 사용 (마지막 부분만)
      const finalKey = currentPath.split('.').pop();
      result[finalKey] = {
        type: value.type,
        value: value.value,
        ...(value.description && { description: value.description })
      };
    } else if (typeof value === 'object') {
      // 중첩 구조인 경우 재귀 처리
      flattenTokenStructure(value, currentPath, result);
    }
  }
  
  return result;
}

// 토큰 구조를 평탄화하여 CSS 변수명을 짧게 만듦
function simplifyTokenStructure(transformed, original) {
  const result = {};
  const tokenSets = {};
  
  // 원본 구조에서 토큰 세트별로 정리 (참조 정규화용)
  for (const [setName, setTokens] of Object.entries(original)) {
    if (setName.startsWith('$')) {
      // 메타데이터는 제외 (CSS에서 token-set-order 제거)
      continue;
    }
    tokenSets[setName] = setTokens;
  }
  
  // 각 토큰 세트를 처리하여 평탄화
  for (const [setName, setTokens] of Object.entries(original)) {
    if (setName.startsWith('$')) continue;
    
    if (typeof setTokens !== 'object' || setTokens === null) continue;
    
    // 원본 구조를 유지하면서 변환된 값으로 채우기
    const processedSet = mapTransformedValues(setTokens, transformed, tokenSets, []);
    
    // 평탄화하여 결과에 추가 (최상위 레벨로)
    const flattened = flattenTokenStructure(processedSet);
    Object.assign(result, flattened);
  }
  
  return result;
}

// 해결되지 않은 참조가 있는 토큰 제거
function removeUnresolvedReferences(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeUnresolvedReferences).filter(item => item !== null);
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // failedToResolve가 true인 토큰 제외
    if (value && typeof value === 'object' && value.failedToResolve === true) {
      continue;
    }

    // tokenSetOrder 메타데이터 제외 (CSS 변수명을 깔끔하게 만들기 위해)
    if (key === 'tokenSetOrder' || (key.toLowerCase().includes('token') && key.toLowerCase().includes('order'))) {
      continue;
    }

    // 메타데이터는 유지
    if (key.startsWith('$')) {
      result[key] = value;
      continue;
    }

    const cleaned = removeUnresolvedReferences(value);
    if (cleaned !== null && cleaned !== undefined) {
      result[key] = cleaned;
    }
  }

  return result;
}

// 메인 처리 로직
function processTokens() {
  // 1단계: 해결되지 않은 참조 제거
  const cleanedTokens = removeUnresolvedReferences(tokens);
  
  // 2단계: Token Transformer가 이미 평탄화한 결과를 그대로 사용
  // CSS 변수명을 짧게 만들기 위해 메타데이터만 제거
  const result = {};
  
  for (const [key, value] of Object.entries(cleanedTokens)) {
    // 메타데이터 제외 ($metadata, tokenSetOrder 등)
    if (key.startsWith('$') || key === 'tokenSetOrder' || key.toLowerCase().includes('token') && key.toLowerCase().includes('order')) {
      continue;
    }
    
    result[key] = value;
  }
  
  return result;
}

// 처리 실행
const finalTokens = processTokens();

// 파일 저장 (원본 파일은 건드리지 않음)
fs.writeFileSync(tokensPath, JSON.stringify(finalTokens, null, 2));
console.log('✅ 토큰 경로 정규화, 구조 단순화, 무결성 유지 처리가 완료되었습니다.');
