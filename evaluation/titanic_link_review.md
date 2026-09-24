# Detailed review of the current Titanic relationships

Cell numbers below are zero-based JSON indices, not execution counts. This review examines the existing saved result; no new model calls were made. It does not prove which prompt produced that file. Judgments are an assistant review, not independent human adjudication. The original benchmark labels remain unchanged.

## Quantitative results

Existing scorer: `{"predictions": 37, "truePositives": 24, "falsePositives": 13, "falseNegatives": 12, "precision": 0.6486486486486487, "recall": 0.6666666666666666, "f1": 0.6575342465753425}`. There are 38 individual relationships but 37 unique cell pairs: (23,24) has two different Markdown excerpts. All 76 saved source portions match their current notebook offsets. Exact text validity does not establish semantic correctness.

## Every unmatched pair

Nine pairs are defensible at the cell-pair level, with caveats; four are partial or weak: (7,16), (9,16), (17,12), (43,46). This is not a recalculated precision score because matched pairs also contain semantic defects and historical runs have not received the same adjudication.

### Markdown 5 → code 8 — Defensible, broad excerpt

A data preview exposes column headings and samples. The direct feature-list command at cell 6 is stronger; the plain-text preview omits some columns with ellipses.

Present in 2 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
Pandas also helps describe the datasets answering following questions early in our project.

**Which features are available in the dataset?**

Noting the feature names for directly manipulating or analyzing these. These feature names are described on the [Kaggle data page here](https://www.kaggle.com/c/titanic/data).
```

Code excerpt:

```python
# preview the data
train_df.head()
```

Model confidence: 0.9. Model reason: Previewing features and sample rows corresponds to markdown's desire to inspect available features; code shows train_df.head() output.

### Markdown 7 → code 16 — Partial / overclaimed

Object-column summaries support Sex and Embarked, but not the full categorical/numerical taxonomy quoted. Survived and Pclass are numeric-coded and excluded from this output. Narrow the Markdown span; confidence 0.88 is too strong for the entire claim.

Present in 3 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Which features are categorical?**

These values classify the samples into sets of similar samples. Within categorical features are the values nominal, ordinal, ratio, or interval based? Among other things this helps us select the appropriate plots for visualization.

- Categorical: Survived, Sex, and Embarked. Ordinal: Pclass.

**Which features are numerical?**

Which features are numerical? These values change from sample to sample. Within numerical features are the values discrete, continuous, or timeseries based? Among other things this helps us select the appropriate plots for visualization.

- Continous: Age, Fare. Discrete: SibSp, Parch.
```

Code excerpt:

```python
train_df.describe(include=['O'])
```

Model confidence: 0.88. Model reason: Markdown identifies categorical features; describe(include=['O']) outputs counts and unique values for object columns (Name, Sex, Ticket, Cabin, Embarked), supporting identification of categorical/object features.

### Markdown 9 → code 16 — Insufficient evidence

An object summary and one modal Ticket value do not demonstrate a mixture of numeric and alphanumeric Ticket values. Cabin’s modal value supports only the Cabin part. Confidence 0.90 overstates support.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Which features are mixed data types?**

Numerical, alphanumeric data within same feature. These are candidates for correcting goal.

- Ticket is a mix of numeric and alphanumeric data types. Cabin is alphanumeric.
```

Code excerpt:

```python
train_df.describe(include=['O'])
```

Model confidence: 0.9. Model reason: Markdown calls out Ticket and Cabin as mixed/alphanumeric; describe(include=['O']) lists Ticket and Cabin as object types and shows unique counts, supporting the claim.

### Markdown 11 → code 12 — Strong pair, minor caveats

info() reports non-null counts. Training missing counts are Cabin 687, Age 177, Embarked 2, matching the stated order. Test Cabin and Age are incomplete, but Fare also has one missing value. The model incorrectly calls the displayed counts null counts rather than non-null counts.

Present in 1 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Which features contain blank, null or empty values?**

These will require correcting.

- Cabin > Age > Embarked features contain a number of null values in that order for the training dataset.
- Cabin > Age are incomplete in case of test dataset.
```

Code excerpt:

```python
train_df.info()
print('_'*40)
test_df.info()
```

Model confidence: 0.98. Model reason: Markdown lists which features have nulls; train_df.info() and test_df.info() output show null counts for Cabin, Age, Embarked matching the described order.

### Markdown 13 → code 14 — Strong pair, overbroad claim

describe() supports 891 samples, survival mean 0.383838 and maximum fare 512.3292. It does not establish external Titanic population/survival statistics or every less-than-1% claim. Narrow to supported observations. Plain-text output elides columns.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**What is the distribution of numerical feature values across the samples?**

This helps us determine, among other early insights, how representative is the training dataset of the actual problem domain.

- Total samples are 891 or 40% of the actual number of passengers on board the Titanic (2,224).
- Survived is a categorical feature with 0 or 1 values.
- Around 38% samples survived representative of the actual survival rate at 32%.
- Most passengers (> 75%) did not travel with parents or children.
- Nearly 30% of the passengers had siblings and/or spouse aboard.
- Fares varied significantly with few passengers (<1%) paying as high as $512.
- Few elderly passengers (<1%) within age range 65-80.
```

Code excerpt:

```python
train_df.describe()
# Review survived rate using `percentiles=[.61, .62]` knowing our problem description mentions 38% survival rate.
# Review Parch distribution using `percentiles=[.75, .8]`
# SibSp distribution `[.68, .69]`
# Age and Fare `[.1, .2, .3, .4, .5, .6, .7, .8, .9, .99]`
```

Model confidence: 0.95. Model reason: Markdown summarizes numerical distributions; train_df.describe() provides counts, mean, std, min/max and percentiles supporting these observations (e.g. count 891, mean Survived ~0.3838, Fare max 512.33).

### Markdown 17 → code 12 — Weak contextual support

info() establishes missing Age values, but does not establish correlation with survival or fill ages. The selected sentence gives correlation as its rationale. A contextual motivation link is possible, but not a strong implementation/evidence link at confidence 0.90.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Completing.**

1. We may want to complete Age feature as it is definitely correlated to survival.
```

Code excerpt:

```python
train_df.info()
```

Model confidence: 0.9. Model reason: Markdown motivates completing Age due to missing values; train_df.info() shows Age has 714 non-null of 891, evidencing missing Age values.

### Markdown 17 → code 19 — Defensible analytical link

The stated goal is to analyze features against survival; grouping survival by Pclass implements that analysis. A group mean is an association summary, not a correlation coefficient.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Correlating.**

We want to know how well does each feature correlate with Survival. We want to do this early in our project and match these quick correlations with modelled correlations later in the project.
```

Code excerpt:

```python
train_df[['Pclass', 'Survived']].groupby(['Pclass'], as_index=False).mean().sort_values(by='Survived', ascending=False)
```

Model confidence: 0.96. Model reason: Markdown describes correlating features with Survival; code computes mean Survived per Pclass to show correlation (Pclass 1 highest survival).

### Markdown 17 → code 20 — Defensible analytical link

Grouping survival by Sex implements the stated analysis goal and yields female 0.742038 and male 0.188908. This relation is already apparent in source.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
**Correlating.**

We want to know how well does each feature correlate with Survival. We want to do this early in our project and match these quick correlations with modelled correlations later in the project.
```

Code excerpt:

```python
train_df[["Sex", "Survived"]].groupby(['Sex'], as_index=False).mean().sort_values(by='Survived', ascending=False)
```

Model confidence: 0.96. Model reason: Code computes Survived mean by Sex, supporting markdown's goal to correlate Sex with Survival (female much higher survival).

### Markdown 18 → code 19 — Defensible pair, flawed span and wording

Pclass survival means support comparing passenger classes, but the selected Markdown also includes the separate Sex claim, which this code does not support. A survival proportion of 0.629630 is not a correlation coefficient or a statistical significance test.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
- **Pclass** We observe significant correlation (>0.5) among Pclass=1 and Survived (classifying #3). We decide to include this feature in our model.
- **Sex** We confirm the observation during problem definition that Sex=female had very high survival rate at 74% (classifying #1).
```

Code excerpt:

```python
train_df[['Pclass', 'Survived']].groupby(['Pclass'], as_index=False).mean().sort_values(by='Survived', ascending=False)
```

Model confidence: 0.95. Model reason: Markdown observation about Pclass correlation is supported by groupby mean showing Pclass 1 survival 0.62963.

### Markdown 18 → code 20 — Strong output-supported link

The exact Markdown claim of 74% female survival is supported by the printed group mean 0.742038. This is a clear example of useful numeric output evidence.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
- **Sex** We confirm the observation during problem definition that Sex=female had very high survival rate at 74% (classifying #1).
```

Code excerpt:

```python
train_df[["Sex", "Survived"]].groupby(['Sex'], as_index=False).mean().sort_values(by='Survived', ascending=False)
```

Model confidence: 0.95. Model reason: Groupby mean by Sex shows female survival 0.742038 supporting the markdown statement.

### Markdown 23 → code 24 — Strong method link; second relationship unverified

The Age-histogram explanation maps directly to FacetGrid and plt.hist. A second relationship for infant survival uses the same pair but is not verified by the supplied text, which only contains object/figure representations. Pair scoring hides that distinction.

Present in 3 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
A histogram chart is useful for analyzing continous numerical variables like Age where banding or ranges will help identify useful patterns. The histogram can indicate distribution of samples using automatically defined bins or equally ranged bands. This helps us answer questions relating to specific bands (Did infants have better survival rate?)
```

Code excerpt:

```python
g = sns.FacetGrid(train_df, col='Survived')
g.map(plt.hist, 'Age', bins=20)
```

Model confidence: 0.96. Model reason: Markdown recommends histograms for Age; code creates a FacetGrid histogram of Age split by Survived.

Markdown excerpt:

```text
- Infants (Age <=4) had high survival rate.
```

Code excerpt:

```python
g = sns.FacetGrid(train_df, col='Survived')
g.map(plt.hist, 'Age', bins=20)
```

Model confidence: 0.7. Model reason: Markdown claims infants had high survival; the histogram by Survived (code) is the visualization used to support this claim (output shows plotted histograms).

### Markdown 43 → code 46 — Weak preparatory link

A 2-by-3 zero array supports preparation for six group estimates, but does not calculate medians or implement the method described in the long selected passage. Cell 45 directly describes this initialization; that stronger pair is missing. Confidence 0.95 is excessive.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
We can consider three methods to complete a numerical continuous feature.

1. A simple way is to generate random numbers between mean and [standard deviation](https://en.wikipedia.org/wiki/Standard_deviation).

2. More accurate way of guessing missing values is to use other correlated features. In our case we note correlation among Age, Gender, and Pclass. Guess Age values using [median](https://en.wikipedia.org/wiki/Median) values for Age across sets of Pclass and Gender feature combinations. So, median Age for Pclass=1 and Gender=0, Pclass=1 and Gender=1, and so on...

3. Combine methods 1 and 2. So instead of guessing age values based on median, use random numbers between mean and standard deviation, based on sets of Pclass and Gender combinations.

Method 1 and 3 will introduce random noise into our models. The results from multiple executions might vary. We will prefer method 2.
```

Code excerpt:

```python
guess_ages = np.zeros((2,3))
guess_ages
```

Model confidence: 0.95. Model reason: Markdown describes preparing to guess ages by Pclass x Gender; code initializes guess_ages array (2x3) to hold those guesses.

### Markdown 94 → code 98 — Strong source-supported link

The Markdown explicitly says to use Y_pred for submission, and the code constructs the submission DataFrame from Y_pred. Cell 95 is the last source-order producer via Random Forest, but execution provenance is not independently verified. Output text is not needed for this link.

Present in 0 of the 3 historical GPT-5 mini runs.

Markdown excerpt:

```text
We decide to use this model's output (Y_pred) for creating our competition submission of results.
```

Code excerpt:

```python
submission = pd.DataFrame({
        "PassengerId": test_df["PassengerId"],
        "Survived": Y_pred
    })
# submission.to_csv('../output/submission.csv', index=False)
```

Model confidence: 0.99. Model reason: Markdown says Random Forest's output will be used for submission; code constructs a submission DataFrame using test_df PassengerId and Y_pred produced by last model prediction.

## Missed reference pairs

| Markdown → code | Review                                                                                                                                          | Present in previous mini runs |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 25 → 26         | Clear miss: multifeature visualization description → faceted histogram.                                                                         | 3/3                           |
| 29 → 30         | Clear miss: Embarked/Sex/Fare/Survived visualization → faceted bar plot.                                                                        | 1/3                           |
| 45 → 46         | Clear miss: explicitly prepare an empty age array → np.zeros((2,3)).                                                                            | 2/3                           |
| 47 → 46         | Reference is contextual: allocation supports six combinations but does not perform the described iteration.                                     | 0/3                           |
| 47 → 48         | Clear miss: Sex/Pclass iteration → nested loops. Reference code excerpt lacks actual indentation; pair remains valid.                           | 2/3                           |
| 59 → 58         | Reference is contextual: cell 58 creates IsAlone but does not drop columns. Current result correctly links the dropping instruction to cell 60. | 0/3                           |
| 74 → 75         | Clear contextual miss: “And the test dataset” → test_df.head(10).                                                                               | 0/3                           |
| 82 → 83         | Clear miss: SVM explanation → SVC().                                                                                                            | 0/3                           |
| 86 → 87         | Clear miss: Naive Bayes explanation → GaussianNB().                                                                                             | 2/3                           |
| 88 → 89         | Clear miss: perceptron explanation → Perceptron().                                                                                              | 0/3                           |
| 92 → 93         | Clear miss: decision-tree explanation → DecisionTreeClassifier().                                                                               | 0/3                           |
| 94 → 95         | Clear miss: Random Forest explanation → RandomForestClassifier(n_estimators=100).                                                               | 0/3                           |

Ten misses are strong reference relationships; two are contextual rather than direct implementations. Five missing pairs had been recovered by at least one previous mini run: (25,26), (29,30), (45,46), (47,48), (86,87). Others are persistent misses in those three archived runs. This describes observed files, not a causal effect of the change.

## Problems hidden by benchmark matches

- (53,54): Markdown says “We can not remove the AgeBand feature”; code removes it. The explanation changes this into “AgeBand is not needed,” overlooking negation. A contradiction-aware relationship could be valid, but the current explanation is wrong.
- (70,71): Markdown says “We can not create FareBand”; code creates it. The explanation again ignores negation. The same negative wording is present in archived runs, so this is not evidence of recent input drift.
- (84,85): Markdown says KNN is worse than SVM. Outputs show KNN 84.74 versus SVM 83.84, so that part is false. The model finds the relevant code but does not flag the contradiction. This is an important missed opportunity for output context.
- (68,69): Markdown prescribes mode, while code uses median. The reason acknowledges that discrepancy, but its excerpt also includes rounding to two decimals, which the code does not perform.
- (41,42) and (66,67): Markdown describes new Gender/Port features, but code overwrites Sex/Embarked. Pair relevance is sound; literal implementation agreement is incomplete.
- (51,52): The Age >64 line selects rows without assigning a category. The model describes the mapping without noting this gap.
- (33,34): The selected Markdown includes regex/API-description claims beyond the basic title-extraction operation; its reason does not establish all of those details.

## What can be concluded about output context

The strongest evidence for value is (18,20), where a numeric output directly corroborates a Markdown claim. Pair (11,12) also benefits from the actual non-null counts. Several other new relationships are source-supported and should not be attributed to output context alone. Nine unmatched pairs were absent from all three old mini runs, while four were already observed; absence from earlier runs is not proof that the implementation caused a link.

The current result expands useful analytical links but still misses obvious implementation links, uses overly broad excerpts, and sometimes ignores contradictions even when outputs expose them. Thus the benchmark decline does not justify declaring all 13 unmatched pairs wrong; equally, the defensible extra pairs do not establish an overall accuracy gain. Repeat matched runs and review both conditions using the same rubric.

Plain-text tables contain ellipses even when the HTML representation may contain more columns. The current extraction prefers plain text, so the model may lose relevant table evidence despite receiving output context. Plot object representations do not expose actual chart values. These limitations should be separated from model reasoning errors.

## Sources

- `titanic.ipynb` and `titanic.linkmaker.json`.
- `evaluation/baselines/titanic_code_only_v0_baseline.json`.
- `evaluation/runs/titanic_model_low/gpt-5-mini/run_1.json` through `run_3.json`.
- Existing exact-pair scorer in `scripts/run_model_evaluation.py`.

## Follow-up: are missing pairs hidden inside larger excerpts?

Checked all 12 missing reference pairs against all 38 returned relationships,
including shared Markdown cells, shared code targets, literal containment, and
whitespace-normalized containment of both reference excerpts in one returned
relationship. No missing pair was recovered through a larger excerpt.

The scorer compares only (Markdown cell index, code cell index); it does not
require identical excerpts. Therefore a larger excerpt within the correct cells
already counts as a match. The 12 misses are absent cell-to-cell connections,
not exact-wording failures. This conclusion concerns the saved, materialized
result; raw responses were not retained, so it cannot distinguish generation
omissions from links rejected during validation.

| Missing pair | What is actually present                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25 → 26      | Neither Markdown 25 nor code 26 participates in a returned relationship.                                                                                                                      |
| 29 → 30      | Neither side participates.                                                                                                                                                                    |
| 45 → 46      | Code 46 is present through Markdown 43, but Markdown 45 is absent. The broad Markdown 43 excerpt does not contain the cell 45 sentence.                                                       |
| 47 → 46      | Code 46 is present through Markdown 43, but Markdown 47 is absent.                                                                                                                            |
| 47 → 48      | Neither side participates.                                                                                                                                                                    |
| 59 → 58      | Both sides appear separately: 59 → 60 describes dropping columns; 57 → 58 describes creating IsAlone. The benchmark's contextual cross-link is absent, while the main operations are covered. |
| 74 → 75      | Neither side participates.                                                                                                                                                                    |
| 82 → 83      | Neither side participates.                                                                                                                                                                    |
| 86 → 87      | Neither side participates.                                                                                                                                                                    |
| 88 → 89      | Neither side participates.                                                                                                                                                                    |
| 92 → 93      | Neither side participates.                                                                                                                                                                    |
| 94 → 95      | Markdown 94 is linked only to submission code 98, using the submission sentence. Its Random Forest explanation and constructor target 95 are not covered.                                     |

Eight missing pairs have neither endpoint in any returned relationship. Two
have only their code target represented elsewhere. One has both endpoints in
separate relationships. One has only its Markdown cell represented, for a
different sentence and target. Thus some surrounding concepts are covered, but
none of the 12 specific reference connections is rescued by excerpt containment.
