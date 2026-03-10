export interface Solution {
  question_type?: "coding" | "mcq" | "academic" | "general"
  answer?: string
  code: string
  thoughts?: string[]
  time_complexity?: string
  space_complexity?: string
  is_code_response?: boolean
}

export interface SolutionsResponse {
  [key: string]: Solution
}

export interface ProblemStatementData {
  problem_statement: string
  content_summary?: string
  question_type?: "coding" | "mcq" | "academic" | "general"
  sub_questions?: string[]
  constraints?: string
  example_input?: string
  example_output?: string
  answer_choices?: string[]
  subject?: string
  answer_format?: string
  existing_work?: string
  key_details?: string[]
}
