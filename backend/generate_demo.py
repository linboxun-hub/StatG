import pandas as pd
import numpy as np
import os

DEMO_DIR = os.path.join(os.path.dirname(__file__), "demo_data")


def generate_demo_data():
    os.makedirs(DEMO_DIR, exist_ok=True)
    np.random.seed(42)
    n_firms = 40
    n_years = 9
    years = list(range(2015, 2024))

    records = []
    firm_id = 1
    for _ in range(n_firms):
        industry = np.random.choice(["制造业", "服务业", "金融业"])
        region = np.random.choice(["华东", "华北", "华南", "华中"])
        edu_base = np.random.randint(12, 22)
        exp_base = np.random.randint(1, 5)
        wage_base = 5000 + edu_base * 300 + np.random.randint(-1000, 1000)

        for year in years:
            years_passed = year - 2015
            wage = int(wage_base + years_passed * 500 + np.random.randint(-500, 500))
            edu = edu_base + np.random.choice([0, 0, 0, 1])
            exp = exp_base + years_passed
            gender = np.random.choice(["男", "女"])
            records.append({
                "id": firm_id,
                "year": year,
                "firm": f"A{firm_id:03d}",
                "industry": industry,
                "wage": wage,
                "edu": edu,
                "exp": exp,
                "gender": gender,
                "region": region,
            })
        firm_id += 1

    df = pd.DataFrame(records)
    df.to_csv(os.path.join(DEMO_DIR, "panel_data.csv"), index=False, encoding="utf-8-sig")

    n_survey = 200
    survey = pd.DataFrame({
        "id": range(1, n_survey + 1),
        "age": np.random.randint(22, 60, n_survey),
        "edu": np.random.randint(9, 22, n_survey),
        "income": np.random.randint(3000, 30000, n_survey),
        "gender": np.random.choice(["男", "女"], n_survey),
        "region": np.random.choice(["华东", "华北", "华南", "华中"], n_survey),
        "married": np.random.choice([0, 1], n_survey),
    })
    survey.to_csv(os.path.join(DEMO_DIR, "income_survey.csv"), index=False, encoding="utf-8-sig")

    return df


if __name__ == "__main__":
    generate_demo_data()
    print("Demo data generated.")
